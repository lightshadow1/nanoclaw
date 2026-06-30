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
  betsMigration,
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
  buildProductionPrompt,
} from './planning-prompts.js';
import {
  canSendProactive,
  readBudget,
  recordProactiveSend,
} from './proactive-budget.js';
import {
  expireOverdueBets,
  formatBetMessage,
  getActedBlogBets,
  getBetById,
  getOpenBets,
  markBetSent,
  MAX_OPEN_BETS,
  parseBetButton,
  renderLedger,
  resolveBetById,
  resolveBetByMessageId,
} from './bet-store.js';
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

// Phase 6: outbound handles for the bet ledger. capCtx carries the host's
// lazy sendMessage/setLedger closures; mainChatJid is where bets publish
// (spawned souls are channel-less — everything surfaces on main's chat).
let capCtx: CapabilityContext | null = null;
let mainChatJid: string | null = null;

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

// Re-render the pinned bet ledger on main's chat. Fire-and-forget: the
// ledger is a convenience surface and must never block or fail the caller.
function refreshLedger(): void {
  if (!db || !capCtx?.setLedger || !mainChatJid) return;
  try {
    const text = renderLedger(db);
    void capCtx
      .setLedger(mainChatJid, MAIN_GROUP_FOLDER, text)
      .catch((err) => logger.warn({ err }, 'Bet ledger refresh failed'));
  } catch (err) {
    logger.warn({ err }, 'Bet ledger render failed');
  }
}

// Host-callable entry point for publishing a proposed bet to the owner's
// channel. The IPC watcher calls this when the main agent (typically the
// check-in task) invokes the `publish_bet` MCP tool. The host owns the
// send: message formatting, response buttons, sent-stamping, proactive
// budget consumption, and the ledger refresh all happen here so the
// container can't skip the bookkeeping.
export type RequestPublishBetOutcome =
  | { ok: true; betId: string }
  | { ok: false; error: string };

export async function requestPublishBet(input: {
  betId: string;
}): Promise<RequestPublishBetOutcome> {
  if (!db || !groupsDir) {
    return { ok: false, error: 'soul capability not initialized' };
  }
  if (!capCtx?.sendMessage) {
    return { ok: false, error: 'host has no outbound channel wired' };
  }
  if (!mainChatJid) {
    return { ok: false, error: 'no main chat registered' };
  }

  const bet = getBetById(db, input.betId);
  if (!bet) return { ok: false, error: `bet ${input.betId} not found` };
  if (bet.status !== 'proposed') {
    return { ok: false, error: `bet is '${bet.status}', not 'proposed'` };
  }

  // Hard guardrail, independent of whatever the container believed.
  const now = new Date();
  if (!canSendProactive(readBudget(groupsDir, MAIN_GROUP_FOLDER, now), now)) {
    return {
      ok: false,
      error: 'proactive budget exhausted or quiet hours — try next window',
    };
  }

  const { text, buttons } = formatBetMessage(bet);
  let messageId: string | null = null;
  try {
    messageId = await capCtx.sendMessage(mainChatJid, text, { buttons });
  } catch (err) {
    return {
      ok: false,
      error: `send failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!markBetSent(db, bet.id, messageId, now)) {
    // Lost a race (double IPC delivery) — the message went out once already.
    return { ok: false, error: 'bet was no longer proposed at send time' };
  }
  recordProactiveSend(groupsDir, MAIN_GROUP_FOLDER, now);
  refreshLedger();
  logger.info({ betId: bet.id, soul: bet.groupFolder }, 'Bet published');
  return { ok: true, betId: bet.id };
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

  // Phase 6: weekly production pass — each soul turns accumulated knowledge
  // + fresh research into at most one decision-ready bet. Main-run (only
  // main's container reaches the DB and every soul's wiki).
  upsertSoulTask({
    id: `soul-production-${MAIN_GROUP_FOLDER}`,
    group_folder: MAIN_GROUP_FOLDER,
    chat_jid: mainJid,
    prompt: buildProductionPrompt(MAIN_GROUP_FOLDER),
    schedule_type: 'cron',
    schedule_value: '0 9 * * 1', // Monday 9 AM local
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
- Today's plan: \`soul/daily-plan.json\` — reminders and project work only (regenerated each morning, archived to \`soul/plan-history/\` each evening).
- Proactive budget: \`soul/proactive-budget.json\` — tracks how many outreach messages you've sent today. Stay within it.
- Your wiki is curated between sessions by a scheduled task. Trust it as your long-term memory; do not duplicate its contents in chat replies.

### Bets

Unprompted outreach to the owner happens ONLY through **bets** — decision-ready findings (a recommendation with pros/cons and a concrete action) stored in the \`bets\` table and published with the \`publish_bet\` tool, which attaches one-tap response buttons and a pinned ledger. Owner silence is the noise baseline: never compose ad-hoc check-ins, never narrate quiet days, never analyze the owner's engagement patterns. If the owner taps a button on a bet (you'll see it as \`[<name> tapped "..."]\`), that's them speaking — act on the choice.

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

  migrations: [
    memoryStreamMigration,
    experimentMigration,
    soulsMigration,
    betsMigration,
  ],

  init: async (ctx) => {
    db = ctx.db;
    groupsDir = ctx.groupsDir;
    capCtx = ctx;
    mainChatJid =
      Object.entries(ctx.registeredGroups()).find(
        ([, g]) => g.folder === MAIN_GROUP_FOLDER,
      )?.[0] ?? null;
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
    capCtx = null;
    mainChatJid = null;
    scaffoldedGroups.clear();
  },

  hooks: {
    // Phase 6: ground-truth bet resolution from interaction events.
    // Button taps carry `bet:<id>:<resolution>`; reactions resolve the bet
    // whose published message was reacted to (👍/❤️ → acted, 👎 → rejected).
    onChannelEvent: (event) => {
      if (!db) return;
      try {
        if (event.kind === 'button') {
          const parsed = parseBetButton(event.data);
          if (!parsed) return;
          const resolved = resolveBetById(
            db,
            parsed.betId,
            parsed.resolution,
            'button',
          );
          if (resolved) {
            logger.info(
              { betId: parsed.betId, resolution: parsed.resolution },
              'Bet resolved via button',
            );
            refreshLedger();
          }
          return;
        }

        // Reaction: only meaningful on a sent bet's message.
        const positive = ['👍', '❤️', '🔥', '💯'].includes(event.emoji);
        const negative = event.emoji === '👎';
        if (!positive && !negative) return;
        const bet = resolveBetByMessageId(
          db,
          event.messageId,
          positive ? 'acted' : 'rejected',
          'reaction',
        );
        if (bet) {
          logger.info(
            { betId: bet.id, emoji: event.emoji },
            'Bet resolved via reaction',
          );
          refreshLedger();
        }
      } catch (err) {
        logger.error({ err }, 'Failed to process channel event for bets');
      }
    },

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

      // Check-in (Phase 6): expire overdue bets host-side first (that's
      // deterministic — no container needed), then spin up the container
      // only when it has actual work:
      //   - a proposed bet exists and the budget allows publishing, or
      //   - a sent bet awaits resolution AND the owner has said something
      //     new (uncurated observations) worth checking for references, or
      //   - the daily plan holds a pending reminder and the budget allows.
      if (task.id === `soul-check-in-${MAIN_GROUP_FOLDER}`) {
        if (!groupsDir) return true;
        const now = new Date();
        if (!db) {
          return canSendProactive(
            readBudget(groupsDir, MAIN_GROUP_FOLDER, now),
            now,
          );
        }
        try {
          if (expireOverdueBets(db, now) > 0) refreshLedger();
        } catch (err) {
          logger.error({ err }, 'Failed to expire overdue bets');
        }

        const budgetOk = canSendProactive(
          readBudget(groupsDir, MAIN_GROUP_FOLDER, now),
          now,
        );
        let hasProposed = false;
        let hasSent = false;
        try {
          for (const bet of getOpenBets(db)) {
            if (bet.status === 'proposed') hasProposed = true;
            if (bet.status === 'sent') hasSent = true;
          }
        } catch (err) {
          logger.error({ err }, 'Failed to read open bets; failing open');
          return true;
        }

        const ownerSpokeRecently =
          hasSent &&
          db
            .prepare(
              `SELECT 1 FROM memory_stream
                WHERE group_folder = ? AND type = 'observation'
                  AND curated = 0
                LIMIT 1`,
            )
            .get(MAIN_GROUP_FOLDER) !== undefined;

        let planHasReminder = false;
        try {
          const planPath = path.join(
            groupsDir,
            MAIN_GROUP_FOLDER,
            'soul',
            'daily-plan.json',
          );
          if (fs.existsSync(planPath)) {
            const plan = JSON.parse(fs.readFileSync(planPath, 'utf-8')) as {
              items?: { type?: string; status?: string }[];
            };
            planHasReminder = (plan.items ?? []).some(
              (i) => i.type === 'reminder' && i.status === 'pending',
            );
          }
        } catch {
          // malformed plan — ignore; reminders just wait for the next pass
        }

        let hasPendingDraft = false;
        try {
          const draftsDir = path.join(
            groupsDir,
            MAIN_GROUP_FOLDER,
            'scout',
            'drafts',
          );
          for (const bet of getActedBlogBets(db)) {
            if (!fs.existsSync(path.join(draftsDir, `${bet.id}.md`))) {
              hasPendingDraft = true;
              break;
            }
          }
        } catch (err) {
          logger.error({ err }, 'Failed to check pending blog drafts');
        }

        return (
          (hasProposed && budgetOk) ||
          ownerSpokeRecently ||
          (planHasReminder && budgetOk) ||
          hasPendingDraft
        );
      }

      // Production pass: skip the weekly run entirely when the ledger is
      // already at capacity — the prompt would just no-op.
      if (task.id === `soul-production-${MAIN_GROUP_FOLDER}`) {
        if (!db) return true;
        try {
          return getOpenBets(db).length < MAX_OPEN_BETS;
        } catch (err) {
          logger.error({ err }, 'Failed to check bet capacity; failing open');
          return true;
        }
      }

      // Morning plan: process any resolved+approved spawn_soul interventions
      // so newly-spawned souls are visible to today's plan, then skip if
      // today's plan is already written. (Phase 6 dropped the experiment
      // state refresh — the timing bandit no longer drives planning.)
      if (task.id === `soul-morning-plan-${MAIN_GROUP_FOLDER}`) {
        if (!groupsDir) return true;
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
