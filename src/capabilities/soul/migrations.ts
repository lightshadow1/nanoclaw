import type { MigrationBundle } from '../types.js';

export const memoryStreamMigration: MigrationBundle = {
  version: '1.0.0',
  up: (db) => {
    db.exec(`
      CREATE TABLE memory_stream (
        id TEXT PRIMARY KEY,
        group_folder TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        type TEXT NOT NULL,
        source TEXT NOT NULL,
        content TEXT NOT NULL,
        importance INTEGER DEFAULT 5,
        metadata TEXT,
        curated INTEGER DEFAULT 0
      );
      CREATE INDEX idx_memory_group ON memory_stream(group_folder);
      CREATE INDEX idx_memory_timestamp ON memory_stream(timestamp);
      CREATE INDEX idx_memory_uncurated ON memory_stream(curated) WHERE curated = 0;
    `);
  },
  // down() drops the table. All accumulated importance scores are lost.
  down: (db) => {
    db.exec(`
      DROP INDEX IF EXISTS idx_memory_uncurated;
      DROP INDEX IF EXISTS idx_memory_timestamp;
      DROP INDEX IF EXISTS idx_memory_group;
      DROP TABLE IF EXISTS memory_stream;
    `);
  },
};
