import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { CronExpressionParser } from 'cron-parser';
import type { Capability, CapabilityContext } from '../types.js';
import { readEnvFile } from '../../env.js';
import { MAIN_GROUP_FOLDER, TIMEZONE, TRIGGER_PATTERN } from '../../config.js';
import { logger } from '../../logger.js';
import { createTask, getTaskById, updateTask } from '../../db.js';
import { memoryStreamMigration } from './migrations.js';
import { addMemory } from './memory-stream.js';
import { heuristicScore } from './heuristic-score.js';
import { ensureWikiForGroup } from './wiki-scaffold.js';
import {
  buildEveningJournalPrompt,
  buildWikiCurationPrompt,
} from './curator-prompts.js';

// Module-level handles so the synchronous hook can reach them
// without re-resolving on every dispatch. Mirrors src/db.ts's pattern.
let db: Database.Database | null = null;
let groupsDir: string | null = null;
const scaffoldedGroups = new Set<string>();

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
    schedule_value: '1800000', // 30 minutes
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

    logger.info({ scaffolded: scaffoldedGroups.size }, 'Soul capability initialized');
  },

  teardown: async () => {
    db = null;
    groupsDir = null;
    scaffoldedGroups.clear();
  },

  hooks: {
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
