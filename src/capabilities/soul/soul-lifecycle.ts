// Soul lifecycle transitions: spawn / markDormant / markActive / archive /
// resurrect. Each is the atomic transition between two states from
// SOUL_PROTOCOL_PROMPT.md §4.1:
//
//   spawn → active → (dormant ⇄ active) → archived
//                                       ↘ resurrect → active
//
// The lifecycle module owns persistence (DB rows + on-disk wiki + key dir)
// and calls the runtime registry / transport via the injected
// LifecycleContext. The caller (step 12, index.ts) wires the real
// transport + handler factory; tests provide stubs.

import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';

import { logger } from '../../logger.js';
import { generateKeypair, loadKeypair, soulKeyDir } from './identity.js';
import type { SignedRequestHandler } from './protocol/transport.js';
import type { LoopbackTransport } from './protocol/transport-loopback.js';
import {
  getSoul,
  registerInMemory,
  unregisterFromMemory,
  updateSoulStateInMemory,
  type ActiveSoul,
  type SoulState,
} from './soul-registry.js';
import { ensureWikiForGroup } from './wiki-scaffold.js';

// Spec §17 constants.
export const DORMANT_THRESHOLD_DAYS = 30;
export const SPAWN_REASON_MAX_LEN = 500;

// Folder slug: lowercase, alphanumeric + hyphens. Same constraint
// soulKeyDir enforces — duplicate here so spawn rejects bad slugs before
// any I/O.
const FOLDER_SLUG_RE = /^[a-z0-9-]+$/;

export interface LifecycleContext {
  db: Database.Database;
  homedir: string;
  groupsDir: string;
  domain: string;
  mainFolder: string;
  transport: LoopbackTransport;
  // Factory the lifecycle calls to build the inbound handler for a
  // newly-registered soul. The factory closes over verifyMessage +
  // handleRequest with the soul's SoulContext.
  buildSoulHandler: (soul: ActiveSoul) => SignedRequestHandler;
}

export interface SpawnSoulOpts {
  folder: string;
  agentName: string;
  description?: string;
  channelJid?: string | null;
  parentFolder: string;
  spawnReason: string;
  seedFromMainTopics?: string[];
  now?: Date;
}

// --- internal helpers -------------------------------------------------------

function soulExists(db: Database.Database, folder: string): boolean {
  const row = db
    .prepare(`SELECT folder FROM souls WHERE folder = ?`)
    .get(folder) as { folder: string } | undefined;
  return row !== undefined;
}

function validateSpawnInput(
  opts: SpawnSoulOpts,
  mainFolder: string,
  db: Database.Database,
): void {
  if (!FOLDER_SLUG_RE.test(opts.folder)) {
    throw new Error(`Invalid folder slug: ${opts.folder}`);
  }
  if (opts.folder === mainFolder) {
    throw new Error(`Reserved folder: ${opts.folder}`);
  }
  if (opts.spawnReason.length === 0) {
    throw new Error('spawnReason must not be empty');
  }
  if (opts.spawnReason.length > SPAWN_REASON_MAX_LEN) {
    throw new Error(
      `spawnReason exceeds SPAWN_REASON_MAX_LEN (${SPAWN_REASON_MAX_LEN})`,
    );
  }
  if (opts.agentName.length === 0) {
    throw new Error('agentName must not be empty');
  }
  if (soulExists(db, opts.folder)) {
    throw new Error(`Soul already exists: ${opts.folder}`);
  }
  if (getSoul(opts.folder)) {
    throw new Error(`Soul already in registry: ${opts.folder}`);
  }
}

function seedWikiFromMain(
  ctx: LifecycleContext,
  spawnedFolder: string,
  pages: string[],
): void {
  const mainWiki = path.join(ctx.groupsDir, ctx.mainFolder, 'soul', 'wiki');
  const spawnedWiki = path.join(ctx.groupsDir, spawnedFolder, 'soul', 'wiki');
  for (const pageName of pages) {
    if (!FOLDER_SLUG_RE.test(pageName) && !/^[a-z0-9_-]+$/i.test(pageName)) {
      logger.warn({ pageName }, 'Skipping invalid seed page name');
      continue;
    }
    const srcPath = path.join(mainWiki, `${pageName}.md`);
    if (!fs.existsSync(srcPath)) continue;
    const content = fs.readFileSync(srcPath, 'utf-8');
    const attributed =
      `<!-- seeded from main wiki on ${new Date().toISOString()} -->\n` +
      content;
    fs.writeFileSync(
      path.join(spawnedWiki, `${pageName}.md`),
      attributed,
      'utf-8',
    );
  }
}

function insertSoulRow(
  db: Database.Database,
  opts: SpawnSoulOpts,
  did: string,
  now: string,
): void {
  db.prepare(
    `INSERT INTO souls
       (folder, owner, channel_jid, agent_name, description, state,
        spawned_at, state_changed_at, did, parent_folder, spawn_reason)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
  ).run(
    opts.folder,
    // Owner is implicit (same as main) — kept here for forward-compat with
    // multi-owner pods (deferred indefinitely). Stored as 'self' v1.
    'self',
    opts.channelJid ?? null,
    opts.agentName,
    opts.description ?? null,
    now,
    now,
    did,
    opts.parentFolder,
    opts.spawnReason,
  );
}

function setTasksStatus(
  db: Database.Database,
  folder: string,
  status: 'active' | 'paused',
): void {
  db.prepare(
    `UPDATE scheduled_tasks SET status = ? WHERE group_folder = ?`,
  ).run(status, folder);
}

function setSoulRowState(
  db: Database.Database,
  folder: string,
  state: SoulState,
  now: string,
): void {
  db.prepare(
    `UPDATE souls SET state = ?, state_changed_at = ? WHERE folder = ?`,
  ).run(state, now, folder);
}

function loadSoulRow(
  db: Database.Database,
  folder: string,
): {
  folder: string;
  agent_name: string;
  channel_jid: string | null;
  did: string;
  state: SoulState;
} | null {
  const row = db
    .prepare(
      `SELECT folder, agent_name, channel_jid, did, state FROM souls WHERE folder = ?`,
    )
    .get(folder) as
    | {
        folder: string;
        agent_name: string;
        channel_jid: string | null;
        did: string;
        state: string;
      }
    | undefined;
  if (!row) return null;
  return {
    folder: row.folder,
    agent_name: row.agent_name,
    channel_jid: row.channel_jid,
    did: row.did,
    state: row.state as SoulState,
  };
}

// --- public lifecycle API ---------------------------------------------------

export function spawnSoul(
  ctx: LifecycleContext,
  opts: SpawnSoulOpts,
): ActiveSoul {
  validateSpawnInput(opts, ctx.mainFolder, ctx.db);

  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();

  // Wiki scaffold (idempotent).
  ensureWikiForGroup(ctx.groupsDir, opts.folder);

  // Keypair (idempotent — generateKeypair noops if files already exist).
  const keyDir = soulKeyDir(ctx.homedir, opts.folder);
  generateKeypair(keyDir);
  const { privateKey, publicKey } = loadKeypair(keyDir);

  // DID — bound to the configured domain.
  const did = `did:wba:${ctx.domain}:agent:${opts.folder}`;

  // Persist.
  insertSoulRow(ctx.db, opts, did, nowIso);

  // Seed wiki pages from main if requested.
  if (opts.seedFromMainTopics && opts.seedFromMainTopics.length > 0) {
    try {
      seedWikiFromMain(ctx, opts.folder, opts.seedFromMainTopics);
    } catch (err) {
      logger.error(
        { folder: opts.folder, err },
        'Failed to seed wiki from main; spawn continues',
      );
    }
  }

  // Build the in-memory soul and wire it into the registry + transport.
  const soul: ActiveSoul = {
    folder: opts.folder,
    agentName: opts.agentName,
    did,
    privateKey,
    publicKey,
    channelJid: opts.channelJid ?? null,
    state: 'active',
  };
  registerInMemory(soul);
  ctx.transport.registerSoul(did, ctx.buildSoulHandler(soul));

  // No per-soul curator task: main is the sole curator for every soul
  // (only main's container has DB access). Main's wiki-curation pass
  // digests this soul's routed memory_stream rows into its wiki.

  logger.info(
    { folder: opts.folder, did, parent: opts.parentFolder },
    'Spawned soul',
  );
  return soul;
}

export function markDormant(
  ctx: LifecycleContext,
  folder: string,
  now: Date = new Date(),
): void {
  if (folder === ctx.mainFolder) {
    throw new Error('Cannot make the main soul dormant');
  }
  const soul = getSoul(folder);
  if (!soul) throw new Error(`Soul not in registry: ${folder}`);
  setSoulRowState(ctx.db, folder, 'dormant', now.toISOString());
  updateSoulStateInMemory(folder, 'dormant');
  setTasksStatus(ctx.db, folder, 'paused');
  // Transport registration stays — wiki is still queryable per spec §4.1.
  logger.info({ folder }, 'Marked soul dormant');
}

export function markActive(
  ctx: LifecycleContext,
  folder: string,
  now: Date = new Date(),
): void {
  if (folder === ctx.mainFolder) return; // main is always active
  const soul = getSoul(folder);
  if (!soul) throw new Error(`Soul not in registry: ${folder}`);
  setSoulRowState(ctx.db, folder, 'active', now.toISOString());
  updateSoulStateInMemory(folder, 'active');
  setTasksStatus(ctx.db, folder, 'active');
  logger.info({ folder }, 'Marked soul active');
}

// Wake any of the given folders that are currently dormant (e.g. the router
// just delivered rows to them — their topic resurfaced). Returns the folders
// actually resurrected. Unknown folders and already-active souls are skipped.
export function resurrectRoutedSouls(
  ctx: LifecycleContext,
  folders: string[],
  now: Date = new Date(),
): string[] {
  const woke: string[] = [];
  for (const folder of folders) {
    const soul = getSoul(folder);
    if (soul && soul.state === 'dormant') {
      markActive(ctx, folder, now);
      woke.push(folder);
    }
  }
  return woke;
}

export function archive(
  ctx: LifecycleContext,
  folder: string,
  now: Date = new Date(),
): void {
  if (folder === ctx.mainFolder) {
    throw new Error('Cannot archive the main soul');
  }
  const soul = getSoul(folder);
  if (!soul) throw new Error(`Soul not in registry: ${folder}`);
  setSoulRowState(ctx.db, folder, 'archived', now.toISOString());
  setTasksStatus(ctx.db, folder, 'paused');
  ctx.transport.unregisterSoul(soul.did);
  unregisterFromMemory(folder);
  logger.info({ folder, did: soul.did }, 'Archived soul');
}

// Scan main's memory_stream for resolved-and-approved spawn_soul
// interventions, call spawnSoul for each, then mark the intervention
// `actioned` so it's not processed twice. Called by the host (typically
// before the morning-plan task runs) so newly-spawned souls are visible
// to the plan.
//
// The container-side evening journal is what flips a spawn_soul
// intervention from `pending` → `resolved` + sets `approved: true|false`
// after seeing the owner's reply. Host-side picks up only the
// approved=true rows.
export interface SpawnApprovalResult {
  spawned: string[];
  errors: Array<{ interventionId: string; error: string }>;
}

interface PendingSpawnRow {
  id: string;
  metadata: string;
  timestamp: string;
}

export function processPendingSpawnApprovals(
  ctx: LifecycleContext,
  now: Date = new Date(),
): SpawnApprovalResult {
  const rows = ctx.db
    .prepare(
      `SELECT id, metadata, timestamp FROM memory_stream
        WHERE group_folder = ?
          AND type = 'intervention'
          AND json_extract(metadata, '$.intervention_type') = 'spawn_soul'
          AND json_extract(metadata, '$.status') = 'resolved'
          AND json_extract(metadata, '$.approved') = 1
          AND (json_extract(metadata, '$.actioned') IS NULL
               OR json_extract(metadata, '$.actioned') = 0)`,
    )
    .all(ctx.mainFolder) as PendingSpawnRow[];

  const spawned: string[] = [];
  const errors: SpawnApprovalResult['errors'] = [];

  for (const row of rows) {
    try {
      const meta = JSON.parse(row.metadata) as {
        proposed_folder?: string;
        proposed_agent_name?: string;
        proposed_topic_keywords?: string[];
        context?: string;
      };
      if (!meta.proposed_folder || !meta.proposed_agent_name) {
        errors.push({
          interventionId: row.id,
          error: 'missing proposed_folder or proposed_agent_name',
        });
        continue;
      }
      // The spawn reason captures *why* — prefer the explicit context if
      // present, otherwise fall back to the keyword list joined as a
      // human-readable topic summary.
      const spawnReason =
        meta.context ??
        meta.proposed_topic_keywords?.join(', ') ??
        'spawned via intervention';

      spawnSoul(ctx, {
        folder: meta.proposed_folder,
        agentName: meta.proposed_agent_name,
        parentFolder: ctx.mainFolder,
        spawnReason: spawnReason.slice(0, SPAWN_REASON_MAX_LEN),
        seedFromMainTopics: ['people', 'preferences'],
        now,
      });
      spawned.push(meta.proposed_folder);
      // Mark the intervention so subsequent passes don't re-spawn.
      ctx.db
        .prepare(
          `UPDATE memory_stream
              SET metadata = json_set(metadata, '$.actioned', 1, '$.actioned_at', ?)
            WHERE id = ?`,
        )
        .run(now.toISOString(), row.id);
    } catch (err) {
      errors.push({
        interventionId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
      logger.error(
        { interventionId: row.id, err },
        'spawn_soul approval failed',
      );
    }
  }

  if (spawned.length > 0) {
    logger.info({ spawned }, 'Processed spawn_soul approvals');
  }
  return { spawned, errors };
}

interface IdleCandidateRow {
  folder: string;
  spawned_at: string;
  last_routed: string | null;
}

// Mark active spawned souls dormant when their activity clock —
// max(newest routed row, spawned_at) — is older than DORMANT_THRESHOLD_DAYS.
// Host-side, deterministic; returns the folders it dormanted.
export function sweepIdleSouls(
  ctx: LifecycleContext,
  now: Date = new Date(),
): string[] {
  const rows = ctx.db
    .prepare(
      `SELECT s.folder AS folder, s.spawned_at AS spawned_at,
              (SELECT MAX(ms.timestamp) FROM memory_stream ms
                WHERE ms.group_folder = s.folder AND ms.source = 'router')
                AS last_routed
         FROM souls s
        WHERE s.state = 'active' AND s.folder != ?`,
    )
    .all(ctx.mainFolder) as IdleCandidateRow[];

  const thresholdMs = DORMANT_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
  const dormanted: string[] = [];

  for (const row of rows) {
    try {
      const spawnedMs = new Date(row.spawned_at).getTime();
      const routedMs = row.last_routed ? new Date(row.last_routed).getTime() : 0;
      const clock = Math.max(spawnedMs, routedMs);
      if (now.getTime() - clock > thresholdMs) {
        markDormant(ctx, row.folder, now);
        dormanted.push(row.folder);
      }
    } catch (err) {
      logger.error({ err, folder: row.folder }, 'sweepIdleSouls: failed on soul');
    }
  }
  return dormanted;
}

export function resurrect(
  ctx: LifecycleContext,
  folder: string,
  now: Date = new Date(),
): ActiveSoul {
  if (folder === ctx.mainFolder) {
    throw new Error('Cannot resurrect the main soul (always active)');
  }
  if (getSoul(folder)) {
    throw new Error(`Soul already active: ${folder}`);
  }
  const row = loadSoulRow(ctx.db, folder);
  if (!row) throw new Error(`No archived soul row for: ${folder}`);
  if (row.state !== 'archived') {
    throw new Error(`Soul ${folder} is not archived (state=${row.state})`);
  }

  const keyDir = soulKeyDir(ctx.homedir, folder);
  const { privateKey, publicKey } = loadKeypair(keyDir);

  setSoulRowState(ctx.db, folder, 'active', now.toISOString());
  setTasksStatus(ctx.db, folder, 'active');

  const soul: ActiveSoul = {
    folder: row.folder,
    agentName: row.agent_name,
    did: row.did,
    privateKey,
    publicKey,
    channelJid: row.channel_jid,
    state: 'active',
  };
  registerInMemory(soul);
  ctx.transport.registerSoul(soul.did, ctx.buildSoulHandler(soul));

  logger.info({ folder, did: soul.did }, 'Resurrected soul');
  return soul;
}
