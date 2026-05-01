import type Database from 'better-sqlite3';
import type { Capability } from '../types.js';
import { readEnvFile } from '../../env.js';
import { TRIGGER_PATTERN } from '../../config.js';
import { logger } from '../../logger.js';
import { memoryStreamMigration } from './migrations.js';
import { addMemory } from './memory-stream.js';
import { heuristicScore } from './heuristic-score.js';
import { ensureWikiForGroup } from './wiki-scaffold.js';

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
