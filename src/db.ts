import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  HISTORY_SEARCH_ENABLED,
  STORE_DIR,
} from './config.js';
import {
  HistorySearchOptions,
  HistorySearchResult,
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
} from './types.js';

let db: Database.Database;

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS capability_migrations (
      capability TEXT NOT NULL,
      version TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      rolled_back_at TEXT,
      PRIMARY KEY (capability, version)
    );
  `);

  if (HISTORY_SEARCH_ENABLED) {
    const historyIndexExists = database
      .prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'`,
      )
      .get();
    database.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content,
        sender_name,
        content='messages',
        content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content, sender_name)
        VALUES (new.rowid, new.content, new.sender_name);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content, sender_name)
        VALUES ('delete', old.rowid, old.content, old.sender_name);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content, sender_name)
        VALUES ('delete', old.rowid, old.content, old.sender_name);
        INSERT INTO messages_fts(rowid, content, sender_name)
        VALUES (new.rowid, new.content, new.sender_name);
      END;
    `);
    if (!historyIndexExists) {
      database.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`);
    }
  }

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN capability_profile TEXT NOT NULL DEFAULT 'full'`,
    );
  } catch {
    /* column already exists */
  }
  try {
    database.exec(`ALTER TABLE task_run_logs ADD COLUMN execution_context TEXT`);
  } catch {
    /* column already exists */
  }

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    database
      .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
      .run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    database.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
    // Backfill from JID patterns
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'telegram', is_group = 1 WHERE jid LIKE 'tg:%'`,
    );
  } catch {
    /* columns already exist */
  }

  // Durable scheduler claims prevent a due task from being queued again while
  // its current occurrence is waiting or running.
  try {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN claim_token TEXT`);
  } catch {
    /* column already exists */
  }
  try {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN claimed_at TEXT`);
  } catch {
    /* column already exists */
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_claim
    ON scheduled_tasks(status, next_run, claim_token)
  `);
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

export function getDb(): Database.Database {
  if (!db)
    throw new Error('Database not initialized. Call initDatabase() first.');
  return db;
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, chatJid, timestamp, ch, group);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id, chat_jid) DO UPDATE SET
       sender = excluded.sender,
       sender_name = excluded.sender_name,
       content = excluded.content,
       timestamp = excluded.timestamp,
       is_from_me = excluded.is_from_me,
       is_bot_message = excluded.is_bot_message`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

/**
 * Store a message directly (for non-WhatsApp channels that don't use Baileys proto).
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
}): void {
  db.prepare(
    `INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id, chat_jid) DO UPDATE SET
       sender = excluded.sender,
       sender_name = excluded.sender_name,
       content = excluded.content,
       timestamp = excluded.timestamp,
       is_from_me = excluded.is_from_me,
       is_bot_message = excluded.is_bot_message`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

function parseHistoryQuery(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) throw new Error('History search query cannot be empty');
  if (trimmed.length > 256)
    throw new Error('History search query exceeds 256 characters');

  const parts = trimmed.match(/"[^"]+"|\S+/g) ?? [];
  return parts
    .map((part) => {
      const quoted = part.startsWith('"') && part.endsWith('"');
      const prefix = !quoted && part.endsWith('*');
      const value = (quoted ? part.slice(1, -1) : prefix ? part.slice(0, -1) : part)
        .replace(/"/g, '""')
        .trim();
      if (!value) throw new Error('History search contains an empty token');
      return `"${value}"${prefix ? '*' : ''}`;
    })
    .join(' AND ');
}

export function searchMessageHistory(
  options: HistorySearchOptions,
): HistorySearchResult[] {
  if (!HISTORY_SEARCH_ENABLED)
    throw new Error('History search is disabled');
  if (options.chatJids.length === 0) return [];

  const limit = Math.min(20, Math.max(1, Math.floor(options.limit ?? 8)));
  const validateTimestamp = (value: string | undefined, name: string) => {
    if (value !== undefined && Number.isNaN(new Date(value).getTime()))
      throw new Error(`Invalid history search ${name} timestamp`);
  };
  validateTimestamp(options.before, 'before');
  validateTimestamp(options.after, 'after');

  const placeholders = options.chatJids.map(() => '?').join(',');
  const conditions = [
    'messages_fts MATCH ?',
    `m.chat_jid IN (${placeholders})`,
  ];
  const params: unknown[] = [parseHistoryQuery(options.query), ...options.chatJids];
  if (options.before) {
    conditions.push('m.timestamp < ?');
    params.push(options.before);
  }
  if (options.after) {
    conditions.push('m.timestamp > ?');
    params.push(options.after);
  }
  if (!options.includeBotMessages) conditions.push('m.is_bot_message = 0');
  params.push(limit);

  const rows = db
    .prepare(
      `SELECT m.id, m.chat_jid, m.sender, m.sender_name,
              substr(m.content, 1, 2000) AS content, m.timestamp,
              m.is_from_me, m.is_bot_message, bm25(messages_fts) AS rank
       FROM messages_fts
       JOIN messages m ON m.rowid = messages_fts.rowid
       WHERE ${conditions.join(' AND ')}
       ORDER BY rank, m.timestamp DESC
       LIMIT ?`,
    )
    .all(...params) as Array<Omit<HistorySearchResult, 'is_from_me' | 'is_bot_message'> & {
      is_from_me: number;
      is_bot_message: number;
    }>;

  const results: HistorySearchResult[] = [];
  let aggregateSize = 2;
  for (const row of rows) {
    const result = {
      ...row,
      is_from_me: row.is_from_me === 1,
      is_bot_message: row.is_bot_message === 1,
    };
    const size = JSON.stringify(result).length;
    if (aggregateSize + size > 20_000) break;
    aggregateSize += size;
    results.push(result);
  }
  return results;
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE timestamp > ? AND chat_jid IN (${placeholders})
      AND is_bot_message = 0 AND content NOT LIKE ?
    ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE chat_jid = ? AND timestamp > ?
      AND is_bot_message = 0 AND content NOT LIKE ?
    ORDER BY timestamp
  `;
  return db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`) as NewMessage[];
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result' | 'capability_profile'> & {
    capability_profile?: ScheduledTask['capability_profile'];
  },
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, capability_profile, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.capability_profile || 'full',
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      | 'prompt'
      | 'schedule_type'
      | 'schedule_value'
      | 'next_run'
      | 'status'
      | 'capability_profile'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.capability_profile !== undefined) {
    fields.push('capability_profile = ?');
    values.push(updates.capability_profile);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export interface ClaimedTask extends ScheduledTask {
  claim_token: string;
  claimed_at: string;
}

export function claimDueTasks(
  now: Date = new Date(),
  limit = 100,
): ClaimedTask[] {
  const nowIso = now.toISOString();
  const boundedLimit = Math.max(1, Math.floor(limit));
  const select = db.prepare(`
    SELECT * FROM scheduled_tasks
    WHERE status = 'active'
      AND next_run IS NOT NULL
      AND next_run <= ?
      AND claim_token IS NULL
    ORDER BY next_run
    LIMIT ?
  `);
  const claim = db.prepare(`
    UPDATE scheduled_tasks
    SET claim_token = ?, claimed_at = ?
    WHERE id = ?
      AND status = 'active'
      AND next_run IS NOT NULL
      AND next_run <= ?
      AND claim_token IS NULL
  `);

  return db
    .transaction(() => {
      const due = select.all(nowIso, boundedLimit) as ScheduledTask[];
      const claimed: ClaimedTask[] = [];
      for (const task of due) {
        const claimToken = randomUUID();
        const result = claim.run(claimToken, nowIso, task.id, nowIso);
        if (result.changes === 1) {
          claimed.push({
            ...task,
            claim_token: claimToken,
            claimed_at: nowIso,
          });
        }
      }
      return claimed;
    })
    .immediate();
}

export function finalizeClaimedTask(
  id: string,
  claimToken: string,
  nextRun: string | null,
  lastResult: string,
  runLog?: TaskRunLog,
): boolean {
  const now = new Date().toISOString();
  const finalize = db.prepare(`
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?,
        status = CASE
          WHEN ? IS NULL AND status = 'active' THEN 'completed'
          ELSE status
        END,
        claim_token = NULL, claimed_at = NULL
    WHERE id = ? AND claim_token = ?
  `);
  const insertLog = db.prepare(`
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error, execution_context)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  return db
    .transaction(() => {
      const result = finalize.run(
        nextRun,
        now,
        lastResult,
        nextRun,
        id,
        claimToken,
      );
      if (result.changes !== 1) return false;
      if (runLog) {
        insertLog.run(
          runLog.task_id,
          runLog.run_at,
          runLog.duration_ms,
          runLog.status,
          runLog.result,
          runLog.error,
          runLog.execution_context ?? null,
        );
      }
      return true;
    })
    .immediate();
}

export function releaseInterruptedTaskClaims(): string[] {
  const rows = db
    .prepare(
      `SELECT id FROM scheduled_tasks WHERE claim_token IS NOT NULL ORDER BY id`,
    )
    .all() as Array<{ id: string }>;
  if (rows.length === 0) return [];
  db.prepare(
    `UPDATE scheduled_tasks SET claim_token = NULL, claimed_at = NULL WHERE claim_token IS NOT NULL`,
  ).run();
  return rows.map((row) => row.id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(groupFolder, sessionId);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
      }
    | undefined;
  if (!row) return undefined;
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
  };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
  );
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db.prepare('SELECT * FROM registered_groups').all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    };
  }
  return result;
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      setRegisteredGroup(jid, group);
    }
  }
}
