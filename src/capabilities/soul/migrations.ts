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

// Phase 4.5: experimentation + feedback. Two tables:
//   - experiment_episodes: immutable per-message outcome log
//   - experiment_tuning:   versioned backoff state (rollback-able)
export const experimentMigration: MigrationBundle = {
  version: '1.1.0',
  up: (db) => {
    db.exec(`
      CREATE TABLE experiment_episodes (
        id TEXT PRIMARY KEY,
        group_folder TEXT NOT NULL,
        plan_item_id TEXT,
        target TEXT,
        timing_arm TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        message_excerpt TEXT,
        outcome TEXT NOT NULL,
        sentiment TEXT,
        proximal_window_min INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_episodes_group_sent
        ON experiment_episodes (group_folder, sent_at);

      CREATE TABLE experiment_tuning (
        id TEXT PRIMARY KEY,
        group_folder TEXT NOT NULL,
        version INTEGER NOT NULL,
        state_json TEXT NOT NULL,
        baseline_efficacy REAL,
        created_at TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX idx_tuning_group_active
        ON experiment_tuning (group_folder, active);
    `);
  },
  down: (db) => {
    db.exec(`
      DROP INDEX IF EXISTS idx_tuning_group_active;
      DROP TABLE IF EXISTS experiment_tuning;
      DROP INDEX IF EXISTS idx_episodes_group_sent;
      DROP TABLE IF EXISTS experiment_episodes;
    `);
  },
};

// Phase 5: multi-soul host. One row per spawned (non-main) soul.
// The main soul lives in MAIN_GROUP_FOLDER config and is NOT a row here —
// keeping it implicit avoids any chicken-and-egg on startup.
//
// folder is PRIMARY KEY (must match the on-disk groups/{folder}/ path).
// state ∈ {'active', 'dormant', 'archived'}; index supports the registry
// load path which only ever asks for non-archived.
export const soulsMigration: MigrationBundle = {
  version: '1.2.0',
  up: (db) => {
    db.exec(`
      CREATE TABLE souls (
        folder TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        channel_jid TEXT,
        agent_name TEXT NOT NULL,
        description TEXT,
        state TEXT NOT NULL,
        spawned_at TEXT NOT NULL,
        state_changed_at TEXT NOT NULL,
        did TEXT NOT NULL,
        parent_folder TEXT,
        spawn_reason TEXT
      );
      CREATE INDEX idx_souls_state ON souls(state);
    `);
  },
  down: (db) => {
    db.exec(`
      DROP INDEX IF EXISTS idx_souls_state;
      DROP TABLE IF EXISTS souls;
    `);
  },
};

// Phase 6: bet ledger. A bet is a decision-ready finding a soul wants to
// surface to the owner: created as 'proposed' (by the main container via
// sqlite3), published to the channel as 'sent' (host stamps the message id),
// and resolved by ground-truth interaction (button tap / reaction / topic
// reference) or host-side timeout after window_days.
export const betsMigration: MigrationBundle = {
  version: '1.3.0',
  up: (db) => {
    db.exec(`
      CREATE TABLE bets (
        id TEXT PRIMARY KEY,
        group_folder TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        recommendation TEXT,
        prediction TEXT,
        status TEXT NOT NULL DEFAULT 'proposed',
        created_at TEXT NOT NULL,
        sent_at TEXT,
        channel_message_id TEXT,
        window_days INTEGER NOT NULL DEFAULT 7,
        resolution TEXT,
        resolution_source TEXT,
        resolved_at TEXT
      );
      CREATE INDEX idx_bets_status ON bets(status);
      CREATE INDEX idx_bets_group ON bets(group_folder);
    `);
  },
  down: (db) => {
    db.exec(`
      DROP INDEX IF EXISTS idx_bets_group;
      DROP INDEX IF EXISTS idx_bets_status;
      DROP TABLE IF EXISTS bets;
    `);
  },
};
