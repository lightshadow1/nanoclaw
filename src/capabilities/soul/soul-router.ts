// Host-side router. Runs before main's wiki curation pass: for each
// uncurated observation in main's memory_stream, decide which spawned
// souls should "see" it, and insert a tagged copy into their own
// memory_stream. Each spawned soul's curator then digests those copies
// into its wiki on the next pass.
//
// v1 = keyword heuristic. Keywords are derived from each spawned soul's
// `spawn_reason` text (which captures the topic at spawn time). Better v2
// would be LLM-based classification at curation time; deferred per spec.
//
// Idempotent. A second routing pass over the same main row is a no-op
// because we check for the source-row backlink before inserting.

import type Database from 'better-sqlite3';

import { logger } from '../../logger.js';
import { addMemory } from './memory-stream.js';

// Tiny stopword list — keeps the keyword index focused on topic terms,
// not the connective tissue of natural language.
const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'has',
  'have',
  'i',
  'in',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'was',
  'will',
  'with',
  'you',
  'your',
  'me',
  'my',
  'we',
  'our',
  'us',
  'they',
  'them',
  'their',
  'about',
  'into',
  'over',
  'soul',
  'project',
  'topic',
  'around',
  'after',
  'before',
  'do',
  'does',
  'did',
  'so',
  'just',
  'like',
  'want',
  'wants',
]);

const MIN_KEYWORD_LEN = 4;

export function extractKeywords(spawnReason: string): string[] {
  const tokens = spawnReason
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    if (t.length < MIN_KEYWORD_LEN) continue;
    if (STOPWORDS.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

export interface RouteResult {
  routed: number;
  perFolder: Record<string, number>;
}

interface SpawnedSoulRow {
  folder: string;
  spawn_reason: string | null;
}

interface MainObservationRow {
  id: string;
  timestamp: string;
  source: string;
  content: string;
  importance: number;
  metadata: string | null;
}

function loadActiveSpawnedSouls(
  db: Database.Database,
  mainFolder: string,
): SpawnedSoulRow[] {
  return db
    .prepare(
      `SELECT folder, spawn_reason FROM souls
        WHERE state = 'active' AND folder != ?`,
    )
    .all(mainFolder) as SpawnedSoulRow[];
}

function loadUncuratedMainObservations(
  db: Database.Database,
  mainFolder: string,
  limit: number,
): MainObservationRow[] {
  return db
    .prepare(
      `SELECT id, timestamp, source, content, importance, metadata
         FROM memory_stream
        WHERE group_folder = ? AND type = 'observation' AND curated = 0
        ORDER BY timestamp ASC
        LIMIT ?`,
    )
    .all(mainFolder, limit) as MainObservationRow[];
}

function alreadyRouted(
  db: Database.Database,
  spawnedFolder: string,
  mainRowId: string,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 as ok FROM memory_stream
        WHERE group_folder = ?
          AND json_extract(metadata, '$.source_main_row_id') = ?
        LIMIT 1`,
    )
    .get(spawnedFolder, mainRowId) as { ok: number } | undefined;
  return row !== undefined;
}

function contentMatches(content: string, keywords: string[]): boolean {
  if (keywords.length === 0) return false;
  const lower = content.toLowerCase();
  for (const kw of keywords) {
    if (lower.includes(kw)) return true;
  }
  return false;
}

// Route uncurated main observations into matching spawned souls'
// memory_stream. Returns counts for diagnostics. Caller invokes this
// from the wiki-curation beforeTaskRun hook so the spawned souls' next
// curator pass picks up the routed rows.
export function routeUncuratedObservationsToSpawnedSouls(
  db: Database.Database,
  mainFolder: string,
  limit: number = 100,
): RouteResult {
  const spawned = loadActiveSpawnedSouls(db, mainFolder);
  if (spawned.length === 0) {
    return { routed: 0, perFolder: {} };
  }

  const keywordsByFolder = new Map<string, string[]>();
  for (const s of spawned) {
    keywordsByFolder.set(s.folder, extractKeywords(s.spawn_reason ?? ''));
  }

  const observations = loadUncuratedMainObservations(db, mainFolder, limit);

  const perFolder: Record<string, number> = {};
  let total = 0;

  for (const obs of observations) {
    for (const s of spawned) {
      const keywords = keywordsByFolder.get(s.folder) ?? [];
      if (!contentMatches(obs.content, keywords)) continue;
      if (alreadyRouted(db, s.folder, obs.id)) continue;

      const originalMeta = obs.metadata
        ? (JSON.parse(obs.metadata) as Record<string, unknown>)
        : {};

      addMemory(db, {
        groupFolder: s.folder,
        timestamp: obs.timestamp,
        type: 'observation',
        source: 'router',
        content: obs.content,
        importance: obs.importance,
        metadata: {
          ...originalMeta,
          source_main_row_id: obs.id,
          source_folder: mainFolder,
          source_type: 'router',
        },
      });
      perFolder[s.folder] = (perFolder[s.folder] ?? 0) + 1;
      total++;
    }
  }

  if (total > 0) {
    logger.info(
      { mainFolder, routed: total, perFolder },
      'Routed main observations to spawned souls',
    );
  }
  return { routed: total, perFolder };
}
