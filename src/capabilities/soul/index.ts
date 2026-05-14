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
import { memoryStreamMigration } from './migrations.js';
import { addMemory, getUncurated } from './memory-stream.js';
import { heuristicScore } from './heuristic-score.js';
import { ensureWikiForGroup } from './wiki-scaffold.js';
import {
  buildEveningJournalPrompt,
  buildWikiCurationPrompt,
} from './curator-prompts.js';
import { generateAgentDescription } from './agent-description.js';
import {
  encodeEd25519PublicKeyMultibase,
  generateDIDDocument,
  generateKeypair,
  loadKeypair,
} from './identity.js';
import { startIdentityServer, stopIdentityServer } from './identity-server.js';

// Module-level handles so the synchronous hook can reach them
// without re-resolving on every dispatch. Mirrors src/db.ts's pattern.
let db: Database.Database | null = null;
let groupsDir: string | null = null;
let identityServer: http.Server | null = null;
const scaffoldedGroups = new Set<string>();

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
    ? traitsRaw.split(',').map((t) => t.trim()).filter(Boolean)
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
    { port, did: `did:wba:${domain}:agent:${agentName}`, skills: skills.length },
    'Soul identity server started',
  );
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
}

const SOUL_CLAUDE_MD_MARKER = '<!-- soul-section -->';
const SOUL_CLAUDE_MD_SECTION = `
${SOUL_CLAUDE_MD_MARKER}
## Soul

You have a soul — a persistent identity and memory that spans sessions.

- Your knowledge wiki lives at \`soul/wiki/\` — start by reading \`soul/wiki/_index.md\` at the beginning of each session.
- Load specific wiki pages (people / preferences / learnings / topic pages) based on what the conversation is about.
- Today's plan: \`soul/daily-plan.json\` (may not exist yet — daily planning ships in a later phase).
- Your wiki is curated between sessions by a scheduled task. Trust it as your long-term memory; do not duplicate its contents in chat replies.
`;

function ensureClaudeMdSection(groupsDirectory: string, folder: string): void {
  const claudePath = path.join(groupsDirectory, folder, 'CLAUDE.md');
  let existing = '';
  if (fs.existsSync(claudePath)) {
    existing = fs.readFileSync(claudePath, 'utf-8');
    if (existing.includes(SOUL_CLAUDE_MD_MARKER)) return;
  } else {
    fs.mkdirSync(path.dirname(claudePath), { recursive: true });
  }
  const separator = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  fs.writeFileSync(claudePath, existing + separator + SOUL_CLAUDE_MD_SECTION, 'utf-8');
  logger.info({ folder }, 'Appended soul section to CLAUDE.md');
}

export const soulCapability: Capability = {
  name: 'soul',

  enabled: () => {
    const env = readEnvFile(['SOUL_ENABLED']);
    const value = process.env.SOUL_ENABLED ?? env.SOUL_ENABLED;
    return value === 'true';
  },

  migrations: [memoryStreamMigration],

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
        logger.error({ err }, 'Failed to ensure soul section in main CLAUDE.md');
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

    logger.info({ scaffolded: scaffoldedGroups.size }, 'Soul capability initialized');
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
    db = null;
    groupsDir = null;
    scaffoldedGroups.clear();
  },

  hooks: {
    beforeTaskRun: (task) => {
      // Only gate the curation task. The evening journal runs unconditionally
      // (it does the deep staleness review and daily-plan reconciliation
      // even on quiet days).
      if (task.id !== `soul-wiki-curation-${MAIN_GROUP_FOLDER}`) return true;
      if (!db) return true; // fail open if soul never initialized
      return getUncurated(db, MAIN_GROUP_FOLDER, 1).length > 0;
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
