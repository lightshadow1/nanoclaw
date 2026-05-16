import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

// 'observation' — inbound message captured from a channel
// 'action'      — outbound message the agent sent
// 'intervention' — agent-raised question awaiting owner input (status in metadata)
// 'plan'        — durable plan-related entry (e.g., morning plan generated, item completed)
export type MemoryType = 'observation' | 'action' | 'intervention' | 'plan';

export interface MemoryEntry {
  id: string;
  groupFolder: string;
  timestamp: string;
  type: MemoryType;
  source: string;
  content: string;
  importance: number;
  metadata: string | null;
  curated: 0 | 1;
}

export interface AddMemoryInput {
  groupFolder: string;
  timestamp: string;
  type: MemoryType;
  source: string;
  content: string;
  importance: number;
  metadata?: Record<string, unknown>;
}

export function addMemory(db: Database.Database, input: AddMemoryInput): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO memory_stream
       (id, group_folder, timestamp, type, source, content, importance, metadata, curated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(
    id,
    input.groupFolder,
    input.timestamp,
    input.type,
    input.source,
    input.content,
    input.importance,
    input.metadata ? JSON.stringify(input.metadata) : null,
  );
  return id;
}

export function getUncurated(
  db: Database.Database,
  groupFolder: string,
  limit = 100,
): MemoryEntry[] {
  const rows = db
    .prepare(
      `SELECT id, group_folder, timestamp, type, source, content, importance, metadata, curated
       FROM memory_stream
       WHERE group_folder = ? AND curated = 0
       ORDER BY timestamp ASC
       LIMIT ?`,
    )
    .all(groupFolder, limit) as Array<{
    id: string;
    group_folder: string;
    timestamp: string;
    type: MemoryType;
    source: string;
    content: string;
    importance: number;
    metadata: string | null;
    curated: 0 | 1;
  }>;

  return rows.map((r) => ({
    id: r.id,
    groupFolder: r.group_folder,
    timestamp: r.timestamp,
    type: r.type,
    source: r.source,
    content: r.content,
    importance: r.importance,
    metadata: r.metadata,
    curated: r.curated,
  }));
}
