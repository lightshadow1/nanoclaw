import type Database from 'better-sqlite3';
import type { Capability } from '../types.js';
import { readEnvFile } from '../../env.js';
import { TRIGGER_PATTERN } from '../../config.js';
import { logger } from '../../logger.js';
import { memoryStreamMigration } from './migrations.js';
import { addMemory } from './memory-stream.js';
import { heuristicScore } from './heuristic-score.js';
import { ensureWikiForGroup } from './wiki-scaffold.js';

// Module-level handle to the db so the synchronous hook can reach it
// without re-resolving on every dispatch. Mirrors src/db.ts's pattern.
let db: Database.Database | null = null;

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
    const groups = ctx.registeredGroups();
    let scaffolded = 0;
    for (const { folder } of Object.values(groups)) {
      try {
        ensureWikiForGroup(ctx.groupsDir, folder);
        scaffolded++;
      } catch (err) {
        logger.error({ folder, err }, 'Failed to scaffold soul wiki');
      }
    }
    logger.info({ scaffolded }, 'Soul capability initialized');
  },

  teardown: async () => {
    db = null;
  },

  hooks: {
    onMessageStored: (msg) => {
      if (!db || !msg.groupFolder) return;

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
  },
};
