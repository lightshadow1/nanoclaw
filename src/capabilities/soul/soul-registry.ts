// Runtime registry of active souls. Lazily loaded from the `souls` table
// on capability init (step 12 wires it). Used by:
//
//   - LoopbackTransport.registerSoul(soul.did, handler) — the transport
//     routes by DID, the registry is what DID-aware code consults.
//   - signing.verifyMessage's resolvePublicKey callback — `verifyMessage`
//     looks up the sender's public key here for in-process callers.
//   - planning + curation tasks that need to enumerate active souls.
//
// Main soul is implicit (per spec §6: not stored in the `souls` table) so
// the caller constructs an ActiveSoul for main and passes it into
// loadActiveSouls. Archived souls are NOT in the registry — they're
// queryable via disk only.

import type Database from 'better-sqlite3';
import type crypto from 'crypto';

import { logger } from '../../logger.js';
import { loadKeypair, soulKeyDir } from './identity.js';

export type SoulState = 'active' | 'dormant' | 'archived';

export interface ActiveSoul {
  folder: string;
  agentName: string;
  did: string;
  privateKey: crypto.KeyObject;
  publicKey: crypto.KeyObject;
  channelJid: string | null;
  state: SoulState;
}

interface SoulRow {
  folder: string;
  owner: string;
  channel_jid: string | null;
  agent_name: string;
  description: string | null;
  state: string;
  spawned_at: string;
  state_changed_at: string;
  did: string;
  parent_folder: string | null;
  spawn_reason: string | null;
}

// Module-level singleton. Same shape as src/db.ts's lazy db and
// signing.ts's seenIds — single process, single registry.
const registry = new Map<string, ActiveSoul>();

// Production teardown drops the in-memory map (used by the soul
// capability's teardown). Tests call the same function via the
// _clearRegistryForTests alias; both empty the same Map.
export function clearRegistry(): void {
  registry.clear();
}
export const _clearRegistryForTests = clearRegistry;

// Snapshot of every soul currently in the registry, in any state. Used by
// the capability's init to register all known souls with the loopback
// transport at boot (post-loadActiveSouls). Distinct from listActiveSouls,
// which filters to state='active'.
export function listAllSouls(): ActiveSoul[] {
  return Array.from(registry.values());
}

// Populate the registry from `souls` rows + the implicit main soul.
// Archived rows are skipped (the registry only knows souls that can be
// queried over loopback). Keypair load failures are logged and that
// soul is skipped — the operator notices a missing key directory at boot
// rather than at first inbound request.
export function loadActiveSouls(
  db: Database.Database,
  homedir: string,
  mainSoul: ActiveSoul,
): Map<string, ActiveSoul> {
  registry.clear();
  registry.set(mainSoul.folder, mainSoul);

  const rows = db
    .prepare(
      `SELECT folder, owner, channel_jid, agent_name, description, state,
              spawned_at, state_changed_at, did, parent_folder, spawn_reason
         FROM souls
        WHERE state != 'archived'`,
    )
    .all() as SoulRow[];

  for (const row of rows) {
    try {
      const keyDir = soulKeyDir(homedir, row.folder);
      const { privateKey, publicKey } = loadKeypair(keyDir);
      registry.set(row.folder, {
        folder: row.folder,
        agentName: row.agent_name,
        did: row.did,
        privateKey,
        publicKey,
        channelJid: row.channel_jid,
        state: row.state as SoulState,
      });
    } catch (err) {
      logger.error(
        { folder: row.folder, err },
        'Failed to load soul keypair; skipping (registry will not know this soul)',
      );
    }
  }

  // Return a snapshot. Mutating the returned map must not corrupt the
  // module's internal state.
  return new Map(registry);
}

export function getSoul(folder: string): ActiveSoul | null {
  return registry.get(folder) ?? null;
}

// All souls known to the registry whose state is `active`. Dormant souls
// are queryable (still in the registry) but excluded here so scheduled
// tasks / outreach paths skip them.
export function listActiveSouls(): ActiveSoul[] {
  return Array.from(registry.values()).filter((s) => s.state === 'active');
}

// Walked linearly — with realistic soul counts (<20) this beats keeping
// a parallel DID index in sync. Networked transports (deferred) will
// fall back to fetching the peer's did.json when this returns null.
//
// Accepts either a bare DID or a DID URL with a `#key-1`-style fragment
// (which is what envelope signatures carry as keyId). The fragment is
// stripped before lookup so callers can pass the keyId verbatim.
export function resolvePublicKeyByDid(did: string): crypto.KeyObject | null {
  const hashIdx = did.indexOf('#');
  const bare = hashIdx === -1 ? did : did.slice(0, hashIdx);
  for (const soul of registry.values()) {
    if (soul.did === bare) return soul.publicKey;
  }
  return null;
}

// --- Mutation helpers for soul-lifecycle.ts ---
//
// Registry is a pure runtime cache: it never writes to the DB. Lifecycle
// owns persistence; these helpers keep the in-memory view consistent
// after a write.

export function registerInMemory(soul: ActiveSoul): void {
  if (registry.has(soul.folder)) {
    throw new Error(`Soul already in registry: ${soul.folder}`);
  }
  registry.set(soul.folder, soul);
}

export function unregisterFromMemory(folder: string): void {
  registry.delete(folder);
}

export function updateSoulStateInMemory(
  folder: string,
  state: SoulState,
): void {
  const soul = registry.get(folder);
  if (!soul) throw new Error(`Soul not in registry: ${folder}`);
  registry.set(folder, { ...soul, state });
}
