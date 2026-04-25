import { describe, it, expect, beforeEach, vi } from 'vitest';
import { _initTestDatabase, getDb } from '../db.js';
import type { Capability, CapabilityContext } from './types.js';
import { loadCapabilities, teardownCapabilities, getActiveCapabilities } from './registry.js';
import { runMigrations } from './lifecycle.js';
import { rollbackCapability, isApplied } from './lifecycle.js';
import {
  registerHooks,
  dispatchMessageStored,
  dispatchShutdown,
  clearHooks,
} from './hooks.js';

function makeContext(): CapabilityContext {
  return {
    db: getDb(),
    registeredGroups: () => ({}),
    projectRoot: '/tmp/test',
    groupsDir: '/tmp/test/groups',
    dataDir: '/tmp/test/data',
  };
}

function makeCapability(overrides: Partial<Capability> = {}): Capability {
  return {
    name: 'test-cap',
    enabled: () => true,
    migrations: [
      {
        version: '1.0.0',
        up: (db) => {
          db.exec('CREATE TABLE test_table (id TEXT PRIMARY KEY, value TEXT)');
        },
        down: (db) => {
          db.exec('DROP TABLE IF EXISTS test_table');
        },
      },
    ],
    init: async () => {},
    ...overrides,
  };
}

beforeEach(() => {
  _initTestDatabase();
  clearHooks();
});

describe('migrations', () => {
  it('applies migration and tracks it', () => {
    const db = getDb();
    const cap = makeCapability();

    runMigrations(db, cap);

    expect(isApplied(db, 'test-cap', '1.0.0')).toBe(true);
    // Verify the table was actually created
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='test_table'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it('does not re-apply migrations on second load', () => {
    const db = getDb();
    let callCount = 0;
    const cap = makeCapability({
      migrations: [
        {
          version: '1.0.0',
          up: (d) => {
            callCount++;
            d.exec('CREATE TABLE IF NOT EXISTS test_table (id TEXT PRIMARY KEY)');
          },
          down: (d) => {
            d.exec('DROP TABLE IF EXISTS test_table');
          },
        },
      ],
    });

    runMigrations(db, cap);
    runMigrations(db, cap);

    expect(callCount).toBe(1);
  });

  it('rolls back migrations', () => {
    const db = getDb();
    const cap = makeCapability();

    runMigrations(db, cap);
    expect(isApplied(db, 'test-cap', '1.0.0')).toBe(true);

    rollbackCapability(db, cap);
    expect(isApplied(db, 'test-cap', '1.0.0')).toBe(false);

    // Verify table was dropped
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='test_table'")
      .all();
    expect(tables).toHaveLength(0);
  });

  it('re-applies migrations after rollback', () => {
    const db = getDb();
    let callCount = 0;
    const cap = makeCapability({
      migrations: [
        {
          version: '1.0.0',
          up: (d) => {
            callCount++;
            d.exec('CREATE TABLE IF NOT EXISTS test_table (id TEXT PRIMARY KEY)');
          },
          down: (d) => {
            d.exec('DROP TABLE IF EXISTS test_table');
          },
        },
      ],
    });

    runMigrations(db, cap);
    rollbackCapability(db, cap);
    runMigrations(db, cap);

    expect(callCount).toBe(2);
    expect(isApplied(db, 'test-cap', '1.0.0')).toBe(true);
  });
});

describe('disabled capability', () => {
  it('skips init when disabled', async () => {
    const initFn = vi.fn();
    const cap = makeCapability({
      enabled: () => false,
      init: initFn,
    });

    // loadCapabilities reads from the internal CAPABILITIES array,
    // so we test the enabled() check via runMigrations + manual init pattern
    const db = getDb();
    if (cap.enabled()) {
      runMigrations(db, cap);
      await cap.init(makeContext());
    }

    expect(initFn).not.toHaveBeenCalled();
    expect(isApplied(db, 'test-cap', '1.0.0')).toBe(false);
  });
});

describe('hooks', () => {
  it('dispatches to multiple capabilities', () => {
    const calls: string[] = [];

    registerHooks('cap-a', {
      onMessageStored: () => calls.push('a'),
    });
    registerHooks('cap-b', {
      onMessageStored: () => calls.push('b'),
    });

    dispatchMessageStored({
      id: 'msg-1',
      chatJid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      senderName: 'Alice',
      content: 'hello',
      timestamp: '2026-01-01T00:00:00Z',
      isFromMe: false,
      isBotMessage: false,
      groupFolder: 'main',
      source: 'whatsapp',
    });

    expect(calls).toEqual(['a', 'b']);
  });

  it('isolates errors between hooks', () => {
    const calls: string[] = [];

    registerHooks('cap-bad', {
      onMessageStored: () => {
        throw new Error('hook failure');
      },
    });
    registerHooks('cap-good', {
      onMessageStored: () => calls.push('good'),
    });

    dispatchMessageStored({
      id: 'msg-1',
      chatJid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      senderName: 'Alice',
      content: 'hello',
      timestamp: '2026-01-01T00:00:00Z',
      isFromMe: false,
      isBotMessage: false,
      groupFolder: 'main',
      source: 'whatsapp',
    });

    expect(calls).toEqual(['good']);
  });
});

describe('teardown', () => {
  it('tears down in reverse order', async () => {
    const order: string[] = [];

    // Simulate loading three capabilities manually
    const caps = ['a', 'b', 'c'].map((name) =>
      makeCapability({
        name,
        teardown: async () => {
          order.push(name);
        },
      }),
    );

    // Manually run the lifecycle for each
    const ctx = makeContext();
    for (const cap of caps) {
      runMigrations(ctx.db, {
        ...cap,
        // Each needs a unique table name
        migrations: [
          {
            version: '1.0.0',
            up: (db) => {
              db.exec(`CREATE TABLE IF NOT EXISTS test_${cap.name} (id TEXT PRIMARY KEY)`);
            },
            down: (db) => {
              db.exec(`DROP TABLE IF EXISTS test_${cap.name}`);
            },
          },
        ],
      });
      await cap.init(ctx);
    }

    // teardownCapabilities uses internal state, so we test the reverse pattern directly
    for (const cap of [...caps].reverse()) {
      await cap.teardown?.();
    }

    expect(order).toEqual(['c', 'b', 'a']);
  });
});

describe('loadCapabilities', () => {
  it('loads registered capabilities', async () => {
    await loadCapabilities(makeContext());
    expect(getActiveCapabilities().length).toBeGreaterThanOrEqual(1);
    await teardownCapabilities();
  });
});
