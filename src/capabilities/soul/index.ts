import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { CronExpressionParser } from 'cron-parser';
import type { Capability, CapabilityContext } from '../types.js';
import { readEnvFile } from '../../env.js';
import {
  ASSISTANT_NAME,
  CHANNELS,
  MAIN_GROUP_FOLDER,
  TIMEZONE,
  TRIGGER_PATTERN,
} from '../../config.js';
import { logger } from '../../logger.js';
import { createTask, getTaskById, updateTask } from '../../db.js';
import {
  experimentMigration,
  memoryStreamMigration,
  soulsMigration,
} from './migrations.js';
import { addMemory, getUncurated } from './memory-stream.js';
import { heuristicScore } from './heuristic-score.js';
import { ensureWikiForGroup } from './wiki-scaffold.js';
import {
  buildEveningJournalPrompt,
  buildWikiCurationPrompt,
} from './curator-prompts.js';
import {
  buildCheckInPrompt,
  buildMorningPlanPrompt,
} from './planning-prompts.js';
import { canSendProactive, readBudget } from './proactive-budget.js';
import { reviewGuardrails, writeExperimentState } from './experiment-store.js';
import {
  discoverCapabilities,
  generateAgentDescription,
} from './agent-description.js';
import {
  encodeEd25519PublicKeyMultibase,
  generateDIDDocument,
  generateKeypair,
  loadKeypair,
  soulKeyDir,
} from './identity.js';
import { startIdentityServer, stopIdentityServer } from './identity-server.js';
// Phase 5: soul-to-soul protocol + multi-soul host wiring.
import { buildEnvelope } from './protocol/envelope.js';
import {
  handleRequest,
  LOOPBACK_DEFAULT_TIER,
  type SoulContext,
} from './protocol/handler.js';
import { signMessage, verifyMessage } from './protocol/signing.js';
import { LoopbackTransport } from './protocol/transport-loopback.js';
import type { SignedRequestHandler } from './protocol/transport.js';
import type { SignedMessage } from './protocol/types.js';
import {
  buildSignedAgentCard,
  capabilitiesForCard,
} from './protocol/agent-card.js';
import {
  type ActiveSoul,
  clearRegistry,
  listAllSouls,
  loadActiveSouls,
  resolvePublicKeyByDid,
} from './soul-registry.js';
import { routeUncuratedObservationsToSpawnedSouls } from './soul-router.js';
import {
  processPendingSpawnApprovals,
  spawnSoul,
  type LifecycleContext,
} from './soul-lifecycle.js';

// Module-level handles so the synchronous hook can reach them
// without re-resolving on every dispatch. Mirrors src/db.ts's pattern.
let db: Database.Database | null = null;
let groupsDir: string | null = null;
let identityServer: http.Server | null = null;
const scaffoldedGroups = new Set<string>();

// Phase 5 module state. Single LoopbackTransport shared across souls;
// lifecycleCtx is what spawn/archive/resurrect close over (also used by
// host-side hooks like processPendingSpawnApprovals).
let loopbackTransport: LoopbackTransport | null = null;
let lifecycleCtx: LifecycleContext | null = null;
let mainSoulDid: string | null = null;

function discoverSkills(projectRoot: string): string[] {
  const skillsDir = path.join(projectRoot, '.claude', 'skills');
  if (!fs.existsSync(skillsDir)) return [];
  try {
    return fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch (err) {
    logger.warn({ err }, 'Failed to enumerate skills directory');
    return [];
  }
}

async function startSoulIdentityServer(ctx: CapabilityContext): Promise<void> {
  const env = readEnvFile([
    'SOUL_DOMAIN',
    'SOUL_PORT',
    'SOUL_OWNER',
    'SOUL_NAME',
    'SOUL_TRAITS',
    'SOUL_DESCRIPTION',
  ]);
  const domain = process.env.SOUL_DOMAIN ?? env.SOUL_DOMAIN;
  if (!domain) {
    logger.info('SOUL_DOMAIN not set, identity server disabled (local-only)');
    return;
  }

  const port = parseInt(process.env.SOUL_PORT ?? env.SOUL_PORT ?? '8444', 10);
  const owner = process.env.SOUL_OWNER ?? env.SOUL_OWNER ?? 'Unknown';
  const agentName = process.env.SOUL_NAME ?? env.SOUL_NAME ?? ASSISTANT_NAME;
  const description = process.env.SOUL_DESCRIPTION ?? env.SOUL_DESCRIPTION;
  const traitsRaw = process.env.SOUL_TRAITS ?? env.SOUL_TRAITS;
  const traits = traitsRaw
    ? traitsRaw
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
    : undefined;

  const keyDir = path.join(os.homedir(), '.config', 'nanoclaw', 'soul');
  generateKeypair(keyDir);
  const { privateKey, publicKeyRaw } = loadKeypair(keyDir);

  const publicKeyMultibase = encodeEd25519PublicKeyMultibase(publicKeyRaw);
  const didDoc = generateDIDDocument({ domain, agentName, publicKeyMultibase });
  const verificationMethodId = `did:wba:${domain}:agent:${agentName}#key-1`;

  const skills = discoverSkills(ctx.projectRoot);
  const agentDesc = generateAgentDescription({
    domain,
    agentName,
    owner,
    description,
    traits,
    channelNames: CHANNELS,
    skillNames: skills,
    hasScheduler: true,
  });

  identityServer = startIdentityServer({
    port,
    didDocument: didDoc,
    agentDescription: agentDesc,
    privateKey,
    verificationMethodId,
  });
  logger.info(
    {
      port,
      did: `did:wba:${domain}:agent:${agentName}`,
      skills: skills.length,
    },
    'Soul identity server started',
  );
}

// --- Phase 5 helpers --------------------------------------------------------

function getSoulDomain(): string {
  const env = readEnvFile(['SOUL_DOMAIN']);
  return process.env.SOUL_DOMAIN ?? env.SOUL_DOMAIN ?? 'localhost';
}

function publicKeyRawFromKeyObject(
  pub: ReturnType<typeof loadKeypair>['publicKey'],
): Uint8Array {
  // Last 32 bytes of the Ed25519 SPKI DER are the raw public key.
  const der = pub.export({ format: 'der', type: 'spki' });
  return Uint8Array.from(der.subarray(der.length - 32));
}

function buildSignedAgentCardFor(
  soul: ActiveSoul,
  projectRoot: string,
  envVals: { owner: string; description?: string; traits?: string[] },
): unknown {
  // Main soul advertises channels + skills; spawned souls don't have
  // direct channel access (spokesperson model — they speak through main).
  const isMain = soul.folder === MAIN_GROUP_FOLDER;
  const caps = capabilitiesForCard(
    discoverCapabilities({
      channelNames: isMain ? CHANNELS : [],
      skillNames: isMain ? discoverSkills(projectRoot) : [],
      hasScheduler: true,
    }),
  );
  return buildSignedAgentCard(
    {
      did: soul.did,
      agentName: soul.agentName,
      owner: envVals.owner,
      description: envVals.description,
      traits: envVals.traits,
      capabilities: caps,
      publicKeyRaw: publicKeyRawFromKeyObject(soul.publicKey),
      verificationMethodId: `${soul.did}#key-1`,
    },
    soul.privateKey,
  );
}

function makeSoulHandlerFactory(
  projectRoot: string,
  cardEnv: { owner: string; description?: string; traits?: string[] },
): (soul: ActiveSoul) => SignedRequestHandler {
  return (soul: ActiveSoul) =>
    async (req: SignedMessage): Promise<SignedMessage> => {
      // Verify before dispatch. Per protocol §3.3 even loopback messages
      // are signed — the receiver doesn't trust the sender's identity by
      // transport alone.
      const verify = verifyMessage(req, {
        resolvePublicKey: resolvePublicKeyByDid,
        expectedTo: soul.did,
      });
      if (!verify.ok) {
        const errEnv = buildEnvelope({
          from: soul.did,
          to: req.envelope.from,
          verb: req.envelope.verb,
          body: { error: { code: 'verify_failed', message: verify.reason } },
        });
        return signMessage(errEnv, soul.privateKey, `${soul.did}#key-1`);
      }
      const sc: SoulContext = {
        did: soul.did,
        keyId: `${soul.did}#key-1`,
        privateKey: soul.privateKey,
        folder: soul.folder,
        agentName: soul.agentName,
        groupsDir: groupsDir!,
        db: db!,
        getAgentCard: () => buildSignedAgentCardFor(soul, projectRoot, cardEnv),
      };
      return handleRequest(req, LOOPBACK_DEFAULT_TIER, sc);
    };
}

function initSoulProtocol(ctx: CapabilityContext, mainJid: string): void {
  const env = readEnvFile([
    'SOUL_OWNER',
    'SOUL_NAME',
    'SOUL_DESCRIPTION',
    'SOUL_TRAITS',
  ]);
  const owner = process.env.SOUL_OWNER ?? env.SOUL_OWNER ?? 'self';
  const agentName = process.env.SOUL_NAME ?? env.SOUL_NAME ?? ASSISTANT_NAME;
  const description = process.env.SOUL_DESCRIPTION ?? env.SOUL_DESCRIPTION;
  const traitsRaw = process.env.SOUL_TRAITS ?? env.SOUL_TRAITS;
  const traits = traitsRaw
    ? traitsRaw
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
    : undefined;
  const homedir = os.homedir();
  const domain = getSoulDomain();

  // Main keypair: always exists by Phase 5. Phase 3 created it only when
  // SOUL_DOMAIN was set; generateKeypair is idempotent so the call here
  // doesn't disturb existing installs.
  const mainKeyDir = soulKeyDir(homedir, null);
  generateKeypair(mainKeyDir);
  const mainKp = loadKeypair(mainKeyDir);

  const mainSoul: ActiveSoul = {
    folder: MAIN_GROUP_FOLDER,
    agentName,
    did: `did:wba:${domain}:agent:${MAIN_GROUP_FOLDER}`,
    privateKey: mainKp.privateKey,
    publicKey: mainKp.publicKey,
    channelJid: mainJid,
    state: 'active',
  };
  mainSoulDid = mainSoul.did;

  loopbackTransport = new LoopbackTransport();
  const transport = loopbackTransport;
  const handlerFactory = makeSoulHandlerFactory(ctx.projectRoot, {
    owner,
    description,
    traits,
  });

  lifecycleCtx = {
    db: ctx.db,
    homedir,
    groupsDir: ctx.groupsDir,
    domain,
    mainFolder: MAIN_GROUP_FOLDER,
    transport,
    buildSoulHandler: handlerFactory,
  };

  // Populate registry from DB + register every soul with the transport.
  loadActiveSouls(ctx.db, homedir, mainSoul);
  for (const s of listAllSouls()) {
    try {
      transport.registerSoul(s.did, handlerFactory(s));
    } catch (err) {
      logger.error(
        { folder: s.folder, err },
        'Failed to register soul with loopback transport',
      );
    }
  }
  logger.info(
    { transports: transport.registeredCount(), mainDid: mainSoul.did },
    'Phase 5 soul protocol initialized',
  );
}

// Host-callable entry point for spawning a soul on owner request. The IPC
// watcher (src/ipc.ts) calls this when the main agent invokes the
// `spawn_soul` MCP tool. Spawned souls are channel-less (spokesperson
// model — they speak through main) and always seeded with main's
// owner-facing wiki pages so they know who the owner is. Returns a
// discriminated outcome rather than throwing so the IPC layer can log
// cleanly; returns an error result (not a throw) when the protocol never
// initialized (soul disabled or no main group).
export interface RequestSpawnSoulInput {
  folder: string;
  agentName: string;
  description?: string;
  spawnReason: string;
  topicKeywords?: string[];
}

export type RequestSpawnSoulOutcome =
  | { ok: true; folder: string; did: string }
  | { ok: false; error: string };

export function requestSpawnSoul(
  input: RequestSpawnSoulInput,
): RequestSpawnSoulOutcome {
  if (!lifecycleCtx) {
    return { ok: false, error: 'soul protocol not initialized' };
  }
  try {
    // The router (soul-router.ts) derives routing keywords from spawn_reason
    // text, so fold any explicit topic keywords into the reason — that's how
    // they reach routing. Clamp to SPAWN_REASON_MAX_LEN (500) so spawnSoul's
    // validator doesn't reject it.
    const reason =
      input.topicKeywords && input.topicKeywords.length > 0
        ? `${input.spawnReason} [topics: ${input.topicKeywords.join(', ')}]`
        : input.spawnReason;
    const soul = spawnSoul(lifecycleCtx, {
      folder: input.folder,
      agentName: input.agentName,
      description: input.description,
      // Channel-less: spawned souls speak through main.
      channelJid: null,
      parentFolder: lifecycleCtx.mainFolder,
      spawnReason: reason.slice(0, 500),
      // Always seed owner context so a fresh soul knows who it serves.
      seedFromMainTopics: ['people', 'preferences'],
    });
    return { ok: true, folder: soul.folder, did: soul.did };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function scaffoldOnce(folder: string): void {
  if (!groupsDir || scaffoldedGroups.has(folder)) return;
  try {
    ensureWikiForGroup(groupsDir, folder);
    scaffoldedGroups.add(folder);
  } catch (err) {
    logger.error({ folder, err }, 'Failed to scaffold soul wiki');
  }
}

interface SoulTaskSpec {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval';
  schedule_value: string;
}

function computeNextRun(
  scheduleType: 'cron' | 'interval',
  scheduleValue: string,
): string {
  if (scheduleType === 'cron') {
    const next = CronExpressionParser.parse(scheduleValue, { tz: TIMEZONE })
      .next()
      .toISOString();
    // cron-parser types toISOString as string|null; in practice a valid
    // expression always produces a date.
    return next ?? new Date().toISOString();
  }
  const ms = parseInt(scheduleValue, 10);
  return new Date(Date.now() + ms).toISOString();
}

function upsertSoulTask(spec: SoulTaskSpec): void {
  const existing = getTaskById(spec.id);
  if (existing) {
    // Refresh prompt/schedule if the code has evolved. Preserve next_run /
    // last_run / last_result / status so an in-flight cadence isn't reset.
    if (
      existing.prompt !== spec.prompt ||
      existing.schedule_value !== spec.schedule_value ||
      existing.schedule_type !== spec.schedule_type
    ) {
      updateTask(spec.id, {
        prompt: spec.prompt,
        schedule_type: spec.schedule_type,
        schedule_value: spec.schedule_value,
      });
      logger.info({ taskId: spec.id }, 'Soul task updated');
    }
    return;
  }
  createTask({
    id: spec.id,
    group_folder: spec.group_folder,
    chat_jid: spec.chat_jid,
    prompt: spec.prompt,
    schedule_type: spec.schedule_type,
    schedule_value: spec.schedule_value,
    context_mode: 'isolated',
    next_run: computeNextRun(spec.schedule_type, spec.schedule_value),
    status: 'active',
    created_at: new Date().toISOString(),
  });
  logger.info({ taskId: spec.id }, 'Soul task created');
}

function ensureSoulTasks(ctx: CapabilityContext): void {
  const groups = ctx.registeredGroups();
  const mainEntry = Object.entries(groups).find(
    ([, g]) => g.folder === MAIN_GROUP_FOLDER,
  );
  if (!mainEntry) {
    logger.info(
      { mainFolder: MAIN_GROUP_FOLDER },
      'No main group registered; skipping soul task setup',
    );
    return;
  }
  const [mainJid] = mainEntry;

  upsertSoulTask({
    id: `soul-wiki-curation-${MAIN_GROUP_FOLDER}`,
    group_folder: MAIN_GROUP_FOLDER,
    chat_jid: mainJid,
    prompt: buildWikiCurationPrompt(MAIN_GROUP_FOLDER),
    schedule_type: 'interval',
    schedule_value: '7200000', // 2 hours — the beforeTaskRun gate skips empty passes for free
  });

  upsertSoulTask({
    id: `soul-evening-journal-${MAIN_GROUP_FOLDER}`,
    group_folder: MAIN_GROUP_FOLDER,
    chat_jid: mainJid,
    prompt: buildEveningJournalPrompt(MAIN_GROUP_FOLDER),
    schedule_type: 'cron',
    schedule_value: '0 22 * * *',
  });

  upsertSoulTask({
    id: `soul-morning-plan-${MAIN_GROUP_FOLDER}`,
    group_folder: MAIN_GROUP_FOLDER,
    chat_jid: mainJid,
    prompt: buildMorningPlanPrompt(MAIN_GROUP_FOLDER),
    schedule_type: 'cron',
    schedule_value: '0 6 * * *',
  });

  upsertSoulTask({
    id: `soul-check-in-${MAIN_GROUP_FOLDER}`,
    group_folder: MAIN_GROUP_FOLDER,
    chat_jid: mainJid,
    prompt: buildCheckInPrompt(MAIN_GROUP_FOLDER),
    schedule_type: 'interval',
    schedule_value: '7200000',
  });
}

const SOUL_CLAUDE_MD_MARKER = '<!-- soul-section -->';
const SOUL_CLAUDE_MD_END_MARKER = '<!-- /soul-section -->';
const SOUL_CLAUDE_MD_SECTION = `
${SOUL_CLAUDE_MD_MARKER}
## Soul

You have a soul — a persistent identity and memory that spans sessions.

- Your knowledge wiki lives at \`soul/wiki/\` — start by reading \`soul/wiki/_index.md\` at the beginning of each session.
- Load specific wiki pages (people / preferences / learnings / topic pages) based on what the conversation is about.
- Today's plan: \`soul/daily-plan.json\` — your scheduled intentions for today (regenerated each morning, archived to \`soul/plan-history/\` each evening).
- Proactive budget: \`soul/proactive-budget.json\` — tracks how many outreach messages you've sent today. Stay within it.
- Your wiki is curated between sessions by a scheduled task. Trust it as your long-term memory; do not duplicate its contents in chat replies.

When you encounter a situation needing human input (approval, clarification, cost exceeding threshold), raise an **intervention** — store it in the memory stream with \`type = 'intervention'\` and structured metadata, then message the owner with the question and options.

### Spawning dedicated souls

When the owner explicitly asks you to create or spawn a dedicated soul for a project, topic, or domain (e.g. "spawn a soul to track the observability project", "make a dedicated soul for travel planning"), use the \`spawn_soul\` tool. This creates a **real** persistent soul: its own knowledge wiki, its own background curation, its own identity — channel-less, speaking through you (the spokesperson model). A spawned soul can surface proposals that appear in your daily plan, attributed to it.

The \`spawn_soul\` tool is the ONLY way to actually create a soul. Writing markdown files in a folder, or scheduling a task, does NOT create a soul — it just makes files. Never tell the owner a soul is "active" or "tracking" unless you called \`spawn_soul\` and it succeeded. If the tool isn't available to you, say you can't create one rather than simulating it.
${SOUL_CLAUDE_MD_END_MARKER}
`;

// Refresh-in-place: replace content between paired markers so existing installs
// pick up updated section content. Legacy installs (only the opening marker,
// no closing marker — Phase 2/3 era) are migrated by replacing from the start
// marker through EOF on the assumption the old section was appended last.
function ensureClaudeMdSection(groupsDirectory: string, folder: string): void {
  const claudePath = path.join(groupsDirectory, folder, 'CLAUDE.md');

  if (!fs.existsSync(claudePath)) {
    fs.mkdirSync(path.dirname(claudePath), { recursive: true });
    fs.writeFileSync(claudePath, SOUL_CLAUDE_MD_SECTION, 'utf-8');
    logger.info({ folder }, 'Created CLAUDE.md with soul section');
    return;
  }

  const existing = fs.readFileSync(claudePath, 'utf-8');
  const startIdx = existing.indexOf(SOUL_CLAUDE_MD_MARKER);

  if (startIdx === -1) {
    // No marker yet — append the section.
    const separator = existing.endsWith('\n') ? '' : '\n';
    fs.writeFileSync(
      claudePath,
      existing + separator + SOUL_CLAUDE_MD_SECTION,
      'utf-8',
    );
    logger.info({ folder }, 'Appended soul section to CLAUDE.md');
    return;
  }

  // Marker exists. Pair it with an end marker if present (Phase 4+);
  // otherwise treat from start marker to EOF as the legacy section.
  const endMarkerSearchFrom = startIdx + SOUL_CLAUDE_MD_MARKER.length;
  const endMarkerIdx = existing.indexOf(
    SOUL_CLAUDE_MD_END_MARKER,
    endMarkerSearchFrom,
  );
  const replaceEnd =
    endMarkerIdx === -1
      ? existing.length
      : endMarkerIdx + SOUL_CLAUDE_MD_END_MARKER.length;

  const before = existing.slice(0, startIdx).replace(/\n*$/, '\n');
  const after = existing.slice(replaceEnd).replace(/^\n*/, '\n');
  const insert = SOUL_CLAUDE_MD_SECTION.replace(/^\n+/, '').replace(/\n+$/, '');
  const proposed = before + insert + after;

  if (proposed === existing) return; // no-op — content already current

  fs.writeFileSync(claudePath, proposed, 'utf-8');
  logger.info({ folder }, 'Refreshed soul section in CLAUDE.md');
}

export const soulCapability: Capability = {
  name: 'soul',

  enabled: () => {
    const env = readEnvFile(['SOUL_ENABLED']);
    const value = process.env.SOUL_ENABLED ?? env.SOUL_ENABLED;
    return value === 'true';
  },

  migrations: [memoryStreamMigration, experimentMigration, soulsMigration],

  init: async (ctx) => {
    db = ctx.db;
    groupsDir = ctx.groupsDir;
    scaffoldedGroups.clear();
    for (const { folder } of Object.values(ctx.registeredGroups())) {
      scaffoldOnce(folder);
    }

    // CLAUDE.md augmentation: only the main group reads its CLAUDE.md as
    // the soul-bearer for now (curation tasks are main-only).
    const hasMainGroup = Object.values(ctx.registeredGroups()).some(
      (g) => g.folder === MAIN_GROUP_FOLDER,
    );
    if (hasMainGroup) {
      try {
        ensureClaudeMdSection(ctx.groupsDir, MAIN_GROUP_FOLDER);
      } catch (err) {
        logger.error(
          { err },
          'Failed to ensure soul section in main CLAUDE.md',
        );
      }
    }

    try {
      ensureSoulTasks(ctx);
    } catch (err) {
      logger.error({ err }, 'Failed to register soul scheduled tasks');
    }

    try {
      await startSoulIdentityServer(ctx);
    } catch (err) {
      // Identity is optional. Failure here must not break message capture
      // or wiki curation.
      logger.error({ err }, 'Failed to start soul identity server');
    }

    // Phase 5: wire the loopback transport + registry. Gated on a
    // registered main group — without it there's no main soul to host.
    const mainGroupEntry = Object.entries(ctx.registeredGroups()).find(
      ([, g]) => g.folder === MAIN_GROUP_FOLDER,
    );
    if (mainGroupEntry) {
      try {
        initSoulProtocol(ctx, mainGroupEntry[0]);
      } catch (err) {
        // Protocol init failure must not break message capture or
        // curation. Souls fall back to Phase 4 behaviour.
        logger.error({ err }, 'Phase 5 soul protocol init failed');
      }
    }

    logger.info(
      { scaffolded: scaffoldedGroups.size },
      'Soul capability initialized',
    );
  },

  teardown: async () => {
    if (identityServer) {
      try {
        await stopIdentityServer(identityServer);
      } catch (err) {
        logger.error({ err }, 'Error stopping soul identity server');
      }
      identityServer = null;
    }
    // Phase 5: drop registry + transport state so a re-init starts clean.
    clearRegistry();
    loopbackTransport = null;
    lifecycleCtx = null;
    mainSoulDid = null;
    db = null;
    groupsDir = null;
    scaffoldedGroups.clear();
  },

  hooks: {
    beforeTaskRun: (task) => {
      // Wiki curation: main is the sole curator for every soul (only it has
      // DB access). Route main's uncurated observations out to spawned
      // souls first, then run the pass if EITHER main or any active spawned
      // soul has something uncurated — otherwise skip the container entirely.
      if (task.id === `soul-wiki-curation-${MAIN_GROUP_FOLDER}`) {
        if (!db) return true; // fail open if soul never initialized
        try {
          routeUncuratedObservationsToSpawnedSouls(db, MAIN_GROUP_FOLDER);
        } catch (err) {
          logger.error({ err }, 'soul-router pass failed; continuing curation');
        }
        const pending = db
          .prepare(
            `SELECT 1 FROM memory_stream
              WHERE curated = 0
                AND (group_folder = ?
                     OR group_folder IN (
                       SELECT folder FROM souls
                        WHERE state = 'active' AND folder != ?))
              LIMIT 1`,
          )
          .get(MAIN_GROUP_FOLDER, MAIN_GROUP_FOLDER);
        return pending !== undefined;
      }

      // Check-in: refresh experiment-state.json so the container reads a
      // current Thompson draw + backoff, then run the (self-rate-limited)
      // guardrail review. Skip the run itself if proactive budget is
      // exhausted or it's quiet hours.
      if (task.id === `soul-check-in-${MAIN_GROUP_FOLDER}`) {
        if (!groupsDir) return true;
        const now = new Date();
        if (db) {
          try {
            writeExperimentState(db, groupsDir, MAIN_GROUP_FOLDER, now);
            const review = reviewGuardrails(db, MAIN_GROUP_FOLDER, now);
            if (review.driftAlerts.length > 0) {
              logger.warn(
                { alerts: review.driftAlerts },
                'Soul guardrail drift alerts',
              );
            }
            if (review.rolledBack) {
              logger.warn(
                {
                  trailing: review.trailingEfficacy,
                  baseline: review.baselineEfficacy,
                },
                'Soul guardrail rolled back backoff state',
              );
            }
          } catch (err) {
            logger.error(
              { err },
              'Failed to refresh experiment state / review guardrails',
            );
          }
        }
        return canSendProactive(
          readBudget(groupsDir, MAIN_GROUP_FOLDER, now),
          now,
        );
      }

      // Morning plan: refresh experiment-state.json so the container reads
      // a current Thompson timing draw + backoff. Also process any
      // resolved+approved spawn_soul interventions so newly-spawned souls
      // are visible to today's plan. Then skip if today's plan is already
      // written.
      if (task.id === `soul-morning-plan-${MAIN_GROUP_FOLDER}`) {
        if (!groupsDir) return true;
        if (db) {
          try {
            writeExperimentState(db, groupsDir, MAIN_GROUP_FOLDER, new Date());
          } catch (err) {
            logger.error(
              { err },
              'Failed to refresh experiment state for morning plan',
            );
          }
        }
        if (lifecycleCtx) {
          try {
            const res = processPendingSpawnApprovals(lifecycleCtx);
            if (res.spawned.length > 0) {
              logger.info(
                { spawned: res.spawned },
                'Spawned souls from approved interventions',
              );
            }
            if (res.errors.length > 0) {
              logger.warn(
                { errors: res.errors },
                'Some spawn_soul approvals failed',
              );
            }
          } catch (err) {
            logger.error({ err }, 'processPendingSpawnApprovals failed');
          }
        }
        const planPath = path.join(
          groupsDir,
          MAIN_GROUP_FOLDER,
          'soul',
          'daily-plan.json',
        );
        if (!fs.existsSync(planPath)) return true;
        try {
          const plan = JSON.parse(fs.readFileSync(planPath, 'utf-8')) as {
            date?: string;
          };
          const today = new Date();
          const todayStr = `${today.getFullYear()}-${String(
            today.getMonth() + 1,
          ).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
          return plan.date !== todayStr;
        } catch {
          return true; // malformed — let the task regenerate
        }
      }

      // The evening journal and unrelated tasks run unconditionally.
      return true;
    },

    onMessageStored: (msg) => {
      if (!db || !msg.groupFolder) return;

      scaffoldOnce(msg.groupFolder);

      const isAddressed = TRIGGER_PATTERN.test(msg.content);
      const importance = heuristicScore({
        content: msg.content,
        isAddressed,
      });

      addMemory(db, {
        groupFolder: msg.groupFolder,
        timestamp: msg.timestamp,
        type: msg.isBotMessage ? 'action' : 'observation',
        source: msg.source ?? 'unknown',
        content: msg.content,
        importance,
        metadata: { messageId: msg.id, chatJid: msg.chatJid },
      });
    },

    onMessageSent: (msg) => {
      if (!db) return;

      scaffoldOnce(msg.groupFolder);

      // Bot output is intrinsically addressed; the heuristic still penalizes
      // mundane fillers and rewards keywords/length/URLs.
      const importance = heuristicScore({
        content: msg.content,
        isAddressed: true,
      });

      addMemory(db, {
        groupFolder: msg.groupFolder,
        timestamp: msg.timestamp,
        type: 'action',
        source: 'agent',
        content: msg.content,
        importance,
        metadata: { chatJid: msg.chatJid },
      });
    },
  },
};
