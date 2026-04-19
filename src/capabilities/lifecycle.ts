import type Database from 'better-sqlite3';
import type { Capability } from './types.js';
import { logger } from '../logger.js';

export function runMigrations(db: Database.Database, capability: Capability): void {
  for (const migration of capability.migrations) {
    if (isApplied(db, capability.name, migration.version)) continue;

    logger.info(
      { capability: capability.name, version: migration.version },
      'Applying migration',
    );
    migration.up(db);
    recordMigration(db, capability.name, migration.version);
  }
}

export function rollbackCapability(
  db: Database.Database,
  capability: Capability,
): void {
  for (const migration of [...capability.migrations].reverse()) {
    if (!isApplied(db, capability.name, migration.version)) continue;

    logger.info(
      { capability: capability.name, version: migration.version },
      'Rolling back migration',
    );
    migration.down(db);
    markRolledBack(db, capability.name, migration.version);
  }
}

export function isApplied(
  db: Database.Database,
  capability: string,
  version: string,
): boolean {
  const row = db
    .prepare(
      `SELECT rolled_back_at FROM capability_migrations
       WHERE capability = ? AND version = ?`,
    )
    .get(capability, version) as { rolled_back_at: string | null } | undefined;

  // Not applied if no row exists or if it was rolled back
  return row != null && row.rolled_back_at == null;
}

function recordMigration(
  db: Database.Database,
  capability: string,
  version: string,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO capability_migrations (capability, version, applied_at, rolled_back_at)
     VALUES (?, ?, ?, NULL)`,
  ).run(capability, version, new Date().toISOString());
}

function markRolledBack(
  db: Database.Database,
  capability: string,
  version: string,
): void {
  db.prepare(
    `UPDATE capability_migrations SET rolled_back_at = ? WHERE capability = ? AND version = ?`,
  ).run(new Date().toISOString(), capability, version);
}
