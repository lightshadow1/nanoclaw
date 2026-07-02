import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { _initTestDatabase, getDb, getTaskById } from '../../db.js';
import { runMigrations, rollbackCapability } from '../lifecycle.js';
import { clearHooks } from '../hooks.js';
import { heuristicScore } from './heuristic-score.js';
import { addMemory, getUncurated } from './memory-stream.js';
import {
  canSendProactive,
  inWithdrawalPeriod,
  PROACTIVE_MAX_MESSAGES,
  PROACTIVE_MIN_GAP_MS,
  readBudget,
  WITHDRAWAL_CYCLE_WEEKS,
  type ProactiveBudget,
} from './proactive-budget.js';
import {
  computePosteriors,
  DRIFT_ALERT_DELTA,
  EPISODE_DECAY_DAYS,
  efficacyRate,
  getRecentEpisodes,
  MIN_OUTREACH_MULTIPLIER,
  readBackoffState,
  reviewGuardrails,
  ROLLBACK_REGRESSION_THRESHOLD,
  ROLLBACK_REVIEW_DAYS,
  writeExperimentState,
} from './experiment-store.js';
import { ensureWikiForGroup } from './wiki-scaffold.js';
import {
  encodeEd25519PublicKeyMultibase,
  encodeMultibase,
  generateDIDDocument,
  generateKeypair,
  loadKeypair,
  signDocument,
  soulKeyDir,
} from './identity.js';
import { canonicalize } from './protocol/canonical.js';
import { buildEnvelope, canonicalEnvelopeBytes } from './protocol/envelope.js';
import {
  _resetReplayCacheForTests,
  REPLAY_TTL_SEC,
  signMessage,
  verifyMessage,
} from './protocol/signing.js';
import {
  isGetAgentCardRequest,
  isProposeInterventionRequest,
  isQueryStateRequest,
  isQueryWikiRequest,
} from './protocol/types.js';
import type { SignedMessage } from './protocol/types.js';
import { LoopbackTransport } from './protocol/transport-loopback.js';
import type { SignedRequestHandler } from './protocol/transport.js';
import {
  folderFromDid,
  handleRequest,
  LOOPBACK_DEFAULT_TIER,
  REQUIRED_TIER,
  type SoulContext,
} from './protocol/handler.js';
import {
  AGENT_CARD_SCHEMA_VERSION,
  buildAgentCard,
  buildSignedAgentCard,
  capabilitiesForCard,
} from './protocol/agent-card.js';
import {
  _clearRegistryForTests,
  getSoul,
  listActiveSouls,
  loadActiveSouls,
  registerInMemory,
  resolvePublicKeyByDid,
  unregisterFromMemory,
  updateSoulStateInMemory,
  type ActiveSoul,
} from './soul-registry.js';
import {
  archive,
  DORMANT_THRESHOLD_DAYS,
  markActive,
  markDormant,
  processPendingSpawnApprovals,
  resurrect,
  resurrectRoutedSouls,
  spawnSoul,
  sweepIdleSouls,
  SPAWN_REASON_MAX_LEN,
  type LifecycleContext,
} from './soul-lifecycle.js';
import {
  extractKeywords,
  routeUncuratedObservationsToSpawnedSouls,
} from './soul-router.js';
import { getTaskById as getTaskByIdFn } from '../../db.js';
import {
  discoverCapabilities,
  generateAgentDescription,
} from './agent-description.js';
import { startIdentityServer, stopIdentityServer } from './identity-server.js';
import {
  armForHour,
  posteriorFor,
  sampleBeta,
  thompsonRanking,
  TIMING_ARM_PRIORS,
  TIMING_ARMS,
  type BetaPosterior,
  type TimingArm,
} from './timing-bandit.js';
import { requestPublishBet, soulCapability } from './index.js';
import { getActedBlogBets } from './bet-store.js';

// Tiny seeded LCG for deterministic bandit tests. Numerical Recipes constants.
function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

let tmpDir: string;

beforeEach(() => {
  _initTestDatabase();
  clearHooks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('heuristicScore', () => {
  it('baseline message scores 3', () => {
    expect(heuristicScore({ content: 'hello there', isAddressed: false })).toBe(
      3,
    );
  });

  it('mundane acknowledgments score 1', () => {
    expect(heuristicScore({ content: 'ok', isAddressed: false })).toBe(1);
    expect(heuristicScore({ content: 'thanks', isAddressed: false })).toBe(1);
    expect(heuristicScore({ content: 'k', isAddressed: false })).toBe(1);
  });

  it('keyword matches add 3', () => {
    expect(
      heuristicScore({ content: 'remember to lock up', isAddressed: false }),
    ).toBe(6);
    expect(
      heuristicScore({ content: 'this is urgent', isAddressed: false }),
    ).toBe(6);
  });

  it('addressed messages add 2', () => {
    expect(heuristicScore({ content: 'hello there', isAddressed: true })).toBe(
      5,
    );
  });

  it('long messages add 1', () => {
    const long = 'a'.repeat(250);
    expect(heuristicScore({ content: long, isAddressed: false })).toBe(4);
  });

  it('URLs add 2', () => {
    expect(
      heuristicScore({
        content: 'check https://example.com',
        isAddressed: false,
      }),
    ).toBe(5);
  });

  it('combines bonuses and clamps to 10', () => {
    const score = heuristicScore({
      content:
        'remember urgent deadline always cancel ' +
        'a'.repeat(250) +
        ' https://x.com',
      isAddressed: true,
    });
    expect(score).toBe(10);
  });

  it('clamps low end to 1', () => {
    expect(heuristicScore({ content: '', isAddressed: false })).toBe(1);
    expect(heuristicScore({ content: 'k', isAddressed: false })).toBe(1);
  });
});

describe('memory stream', () => {
  beforeEach(() => {
    runMigrations(getDb(), soulCapability);
  });

  it('addMemory inserts and returns id', () => {
    const id = addMemory(getDb(), {
      groupFolder: 'main',
      timestamp: '2026-04-24T10:00:00Z',
      type: 'observation',
      source: 'whatsapp',
      content: 'hello',
      importance: 5,
      metadata: { messageId: 'msg-1', chatJid: 'group@g.us' },
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const rows = getUncurated(getDb(), 'main');
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('hello');
    expect(rows[0].importance).toBe(5);
    expect(rows[0].curated).toBe(0);
    expect(JSON.parse(rows[0].metadata!)).toEqual({
      messageId: 'msg-1',
      chatJid: 'group@g.us',
    });
  });

  it('getUncurated partitions by group_folder', () => {
    addMemory(getDb(), {
      groupFolder: 'main',
      timestamp: '2026-04-24T10:00:00Z',
      type: 'observation',
      source: 'whatsapp',
      content: 'main message',
      importance: 5,
    });
    addMemory(getDb(), {
      groupFolder: 'other',
      timestamp: '2026-04-24T10:00:00Z',
      type: 'observation',
      source: 'whatsapp',
      content: 'other message',
      importance: 5,
    });

    expect(getUncurated(getDb(), 'main')).toHaveLength(1);
    expect(getUncurated(getDb(), 'other')).toHaveLength(1);
    expect(getUncurated(getDb(), 'main')[0].content).toBe('main message');
  });

  it('accepts intervention and plan as MemoryType', () => {
    // Phase 4 expanded the MemoryType union; the existing schema stores type
    // as TEXT so no migration was needed — this test guards the type-level
    // change against accidental future narrowing.
    const interventionId = addMemory(getDb(), {
      groupFolder: 'main',
      timestamp: '2026-05-15T10:00:00Z',
      type: 'intervention',
      source: 'agent',
      content: 'Should I reschedule the dentist?',
      importance: 8,
      metadata: { intervention_type: 'approval_needed', status: 'pending' },
    });
    const planId = addMemory(getDb(), {
      groupFolder: 'main',
      timestamp: '2026-05-15T06:00:00Z',
      type: 'plan',
      source: 'agent',
      content: 'Generated daily plan with 4 items',
      importance: 6,
    });
    expect(interventionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(planId).toMatch(/^[0-9a-f-]{36}$/);

    const rows = getUncurated(getDb(), 'main');
    const types = rows.map((r) => r.type).sort();
    expect(types).toEqual(['intervention', 'plan']);
  });

  it('migration rollback drops the table', () => {
    rollbackCapability(getDb(), soulCapability);
    const tables = getDb()
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_stream'",
      )
      .all();
    expect(tables).toHaveLength(0);
  });
});

describe('ensureWikiForGroup', () => {
  it('creates starter pages on first run', () => {
    ensureWikiForGroup(tmpDir, 'main');
    const wikiDir = path.join(tmpDir, 'main', 'soul', 'wiki');
    expect(fs.existsSync(path.join(wikiDir, '_index.md'))).toBe(true);
    expect(fs.existsSync(path.join(wikiDir, 'people.md'))).toBe(true);
    expect(fs.existsSync(path.join(wikiDir, 'preferences.md'))).toBe(true);
    expect(fs.existsSync(path.join(wikiDir, 'learnings.md'))).toBe(true);
  });

  it('does not overwrite existing files', () => {
    ensureWikiForGroup(tmpDir, 'main');
    const peoplePath = path.join(tmpDir, 'main', 'soul', 'wiki', 'people.md');
    fs.writeFileSync(peoplePath, '# Custom content', 'utf-8');

    ensureWikiForGroup(tmpDir, 'main');
    expect(fs.readFileSync(peoplePath, 'utf-8')).toBe('# Custom content');
  });
});

describe('soul curation gating (main curates all souls)', () => {
  beforeEach(() => {
    runMigrations(getDb(), soulCapability);
  });

  const MAIN_CURATION = {
    id: 'soul-wiki-curation-main',
    group_folder: 'main',
    schedule_type: 'interval' as const,
  };

  function insertActiveSoul(folder: string): void {
    getDb()
      .prepare(
        `INSERT INTO souls
           (folder, owner, channel_jid, agent_name, description, state,
            spawned_at, state_changed_at, did, parent_folder, spawn_reason)
         VALUES (?, 'self', NULL, ?, NULL, 'active',
            '2026-04-24T00:00:00Z', '2026-04-24T00:00:00Z', ?, 'main', 'x')`,
      )
      .run(folder, folder, `did:wba:host:agent:${folder}`);
  }

  it('runs when an active spawned soul has uncurated rows (main itself empty)', async () => {
    await soulCapability.init({
      db: getDb(),
      registeredGroups: () => ({}),
      projectRoot: tmpDir,
      groupsDir: tmpDir,
      dataDir: tmpDir,
    });
    const beforeTaskRun = soulCapability.hooks!.beforeTaskRun!;
    insertActiveSoul('proj-x');

    // Nothing uncurated anywhere → skip.
    expect(await beforeTaskRun(MAIN_CURATION)).toBe(false);

    // A spawned soul has an uncurated row → main must run to curate it.
    addMemory(getDb(), {
      groupFolder: 'proj-x',
      timestamp: '2026-04-24T10:00:00Z',
      type: 'observation',
      source: 'router',
      content: 'something for proj-x',
      importance: 5,
      metadata: {},
    });
    expect(await beforeTaskRun(MAIN_CURATION)).toBe(true);

    await soulCapability.teardown!();
  });

  it('runs when main itself has uncurated rows', async () => {
    await soulCapability.init({
      db: getDb(),
      registeredGroups: () => ({}),
      projectRoot: tmpDir,
      groupsDir: tmpDir,
      dataDir: tmpDir,
    });
    const beforeTaskRun = soulCapability.hooks!.beforeTaskRun!;

    expect(await beforeTaskRun(MAIN_CURATION)).toBe(false);
    addMemory(getDb(), {
      groupFolder: 'main',
      timestamp: '2026-04-24T10:00:00Z',
      type: 'observation',
      source: 'whatsapp',
      content: 'remember the deadline',
      importance: 6,
      metadata: {},
    });
    expect(await beforeTaskRun(MAIN_CURATION)).toBe(true);

    await soulCapability.teardown!();
  });

  it('ignores uncurated rows of archived (non-active) souls', async () => {
    await soulCapability.init({
      db: getDb(),
      registeredGroups: () => ({}),
      projectRoot: tmpDir,
      groupsDir: tmpDir,
      dataDir: tmpDir,
    });
    const beforeTaskRun = soulCapability.hooks!.beforeTaskRun!;
    insertActiveSoul('proj-x');
    getDb()
      .prepare(`UPDATE souls SET state = 'archived' WHERE folder = 'proj-x'`)
      .run();

    addMemory(getDb(), {
      groupFolder: 'proj-x',
      timestamp: '2026-04-24T10:00:00Z',
      type: 'observation',
      source: 'router',
      content: 'stale row for an archived soul',
      importance: 5,
      metadata: {},
    });
    // Archived soul's rows don't pull main into a curation run.
    expect(await beforeTaskRun(MAIN_CURATION)).toBe(false);

    await soulCapability.teardown!();
  });
});

describe('soulCapability hook', () => {
  beforeEach(() => {
    runMigrations(getDb(), soulCapability);
  });

  it('writes inbound messages to memory stream when initialized', async () => {
    await soulCapability.init({
      db: getDb(),
      registeredGroups: () => ({}),
      projectRoot: tmpDir,
      groupsDir: tmpDir,
      dataDir: tmpDir,
    });

    soulCapability.hooks!.onMessageStored!({
      id: 'msg-1',
      chatJid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      senderName: 'Alice',
      content: 'remember the deadline',
      timestamp: '2026-04-24T10:00:00Z',
      isFromMe: false,
      isBotMessage: false,
      groupFolder: 'main',
      source: 'whatsapp',
    });

    const rows = getUncurated(getDb(), 'main');
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('observation');
    expect(rows[0].source).toBe('whatsapp');
    expect(rows[0].importance).toBeGreaterThanOrEqual(6);

    await soulCapability.teardown!();
  });

  it('skips messages with no group folder', async () => {
    await soulCapability.init({
      db: getDb(),
      registeredGroups: () => ({}),
      projectRoot: tmpDir,
      groupsDir: tmpDir,
      dataDir: tmpDir,
    });

    soulCapability.hooks!.onMessageStored!({
      id: 'msg-1',
      chatJid: 'unknown@g.us',
      sender: '123@s.whatsapp.net',
      senderName: 'Alice',
      content: 'hello',
      timestamp: '2026-04-24T10:00:00Z',
      isFromMe: false,
      isBotMessage: false,
      groupFolder: null,
      source: 'whatsapp',
    });

    const rows = getDb()
      .prepare('SELECT COUNT(*) as n FROM memory_stream')
      .get() as {
      n: number;
    };
    expect(rows.n).toBe(0);

    await soulCapability.teardown!();
  });

  it('marks bot messages as actions', async () => {
    await soulCapability.init({
      db: getDb(),
      registeredGroups: () => ({}),
      projectRoot: tmpDir,
      groupsDir: tmpDir,
      dataDir: tmpDir,
    });

    soulCapability.hooks!.onMessageStored!({
      id: 'msg-1',
      chatJid: 'group@g.us',
      sender: 'self',
      senderName: 'Andy',
      content: 'I sent this',
      timestamp: '2026-04-24T10:00:00Z',
      isFromMe: true,
      isBotMessage: true,
      groupFolder: 'main',
      source: 'whatsapp',
    });

    const rows = getUncurated(getDb(), 'main');
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('action');

    await soulCapability.teardown!();
  });

  it('onMessageSent records agent output as action row', async () => {
    await soulCapability.init({
      db: getDb(),
      registeredGroups: () => ({}),
      projectRoot: tmpDir,
      groupsDir: tmpDir,
      dataDir: tmpDir,
    });

    soulCapability.hooks!.onMessageSent!({
      chatJid: 'tg:1903482562',
      content: "Here's the current weather for Kitchener…",
      timestamp: '2026-04-30T11:10:00Z',
      groupFolder: 'main',
    });

    const rows = getUncurated(getDb(), 'main');
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('action');
    expect(rows[0].source).toBe('agent');
    expect(JSON.parse(rows[0].metadata!)).toEqual({ chatJid: 'tg:1903482562' });

    await soulCapability.teardown!();
  });

  it('onMessageSent scaffolds the wiki for a never-seen group', async () => {
    await soulCapability.init({
      db: getDb(),
      registeredGroups: () => ({}),
      projectRoot: tmpDir,
      groupsDir: tmpDir,
      dataDir: tmpDir,
    });

    soulCapability.hooks!.onMessageSent!({
      chatJid: 'tg:1',
      content: 'hi',
      timestamp: '2026-04-30T11:10:00Z',
      groupFolder: 'fresh',
    });

    expect(
      fs.existsSync(path.join(tmpDir, 'fresh', 'soul', 'wiki', '_index.md')),
    ).toBe(true);

    await soulCapability.teardown!();
  });

  it('hook is a no-op after teardown', async () => {
    await soulCapability.init({
      db: getDb(),
      registeredGroups: () => ({}),
      projectRoot: tmpDir,
      groupsDir: tmpDir,
      dataDir: tmpDir,
    });
    await soulCapability.teardown!();

    soulCapability.hooks!.onMessageStored!({
      id: 'msg-1',
      chatJid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      senderName: 'Alice',
      content: 'hello',
      timestamp: '2026-04-24T10:00:00Z',
      isFromMe: false,
      isBotMessage: false,
      groupFolder: 'main',
      source: 'whatsapp',
    });

    const rows = getDb()
      .prepare('SELECT COUNT(*) as n FROM memory_stream')
      .get() as {
      n: number;
    };
    expect(rows.n).toBe(0);
  });
});

describe('ensureSoulTasks', () => {
  beforeEach(() => {
    runMigrations(getDb(), soulCapability);
  });

  function mainGroup() {
    return {
      'group-main@g.us': { name: 'Main', folder: 'main' },
    };
  }

  it('creates curation, journal, morning plan, and check-in tasks for the main group', async () => {
    await soulCapability.init({
      db: getDb(),
      registeredGroups: mainGroup,
      projectRoot: tmpDir,
      groupsDir: tmpDir,
      dataDir: tmpDir,
    });

    const curation = getTaskById('soul-wiki-curation-main');
    const journal = getTaskById('soul-evening-journal-main');
    const morning = getTaskById('soul-morning-plan-main');
    const checkIn = getTaskById('soul-check-in-main');

    expect(curation).toBeDefined();
    expect(curation!.group_folder).toBe('main');
    expect(curation!.chat_jid).toBe('group-main@g.us');
    expect(curation!.schedule_type).toBe('interval');
    expect(curation!.schedule_value).toBe('7200000');
    expect(curation!.context_mode).toBe('isolated');
    expect(curation!.status).toBe('active');
    expect(curation!.next_run).toBeTruthy();
    expect(curation!.prompt).toContain('memory_stream');

    expect(journal).toBeDefined();
    expect(journal!.schedule_type).toBe('cron');
    expect(journal!.schedule_value).toBe('0 22 * * *');
    expect(journal!.prompt).toContain('evening journal');

    expect(morning).toBeDefined();
    expect(morning!.schedule_type).toBe('cron');
    expect(morning!.schedule_value).toBe('0 6 * * *');
    expect(morning!.prompt).toContain('daily-plan.json');

    expect(checkIn).toBeDefined();
    expect(checkIn!.schedule_type).toBe('interval');
    expect(checkIn!.schedule_value).toBe('7200000');
    expect(checkIn!.prompt).toContain('proactive-budget.json');

    const production = getTaskById('soul-production-main');
    expect(production).toBeDefined();
    expect(production!.schedule_type).toBe('cron');
    expect(production!.schedule_value).toBe('0 9 * * 1');
    expect(production!.prompt).toContain('INSERT INTO bets');

    await soulCapability.teardown!();
  });

  it('creates no tasks when no main group is registered', async () => {
    await soulCapability.init({
      db: getDb(),
      registeredGroups: () => ({
        'g1@g.us': { name: 'Side', folder: 'side' },
      }),
      projectRoot: tmpDir,
      groupsDir: tmpDir,
      dataDir: tmpDir,
    });

    expect(getTaskById('soul-wiki-curation-main')).toBeUndefined();
    expect(getTaskById('soul-evening-journal-main')).toBeUndefined();
    expect(getTaskById('soul-morning-plan-main')).toBeUndefined();
    expect(getTaskById('soul-check-in-main')).toBeUndefined();
    expect(getTaskById('soul-wiki-curation-side')).toBeUndefined();

    await soulCapability.teardown!();
  });

  it('is idempotent across re-init and does not duplicate tasks', async () => {
    await soulCapability.init({
      db: getDb(),
      registeredGroups: mainGroup,
      projectRoot: tmpDir,
      groupsDir: tmpDir,
      dataDir: tmpDir,
    });
    const firstNextRun = getTaskById('soul-wiki-curation-main')!.next_run;
    await soulCapability.teardown!();

    await soulCapability.init({
      db: getDb(),
      registeredGroups: mainGroup,
      projectRoot: tmpDir,
      groupsDir: tmpDir,
      dataDir: tmpDir,
    });

    const count = getDb()
      .prepare(
        "SELECT COUNT(*) as n FROM scheduled_tasks WHERE id LIKE 'soul-%'",
      )
      .get() as { n: number };
    expect(count.n).toBe(5);

    // next_run was preserved (cadence not reset on re-init)
    expect(getTaskById('soul-wiki-curation-main')!.next_run).toBe(firstNextRun);

    await soulCapability.teardown!();
  });
});

describe('soulCapability beforeTaskRun gate', () => {
  beforeEach(() => {
    runMigrations(getDb(), soulCapability);
  });

  function ctx() {
    return {
      db: getDb(),
      registeredGroups: () => ({
        'g@g.us': { name: 'Main', folder: 'main' },
      }),
      projectRoot: tmpDir,
      groupsDir: tmpDir,
      dataDir: tmpDir,
    };
  }

  function curationTask() {
    return {
      id: 'soul-wiki-curation-main',
      group_folder: 'main',
      schedule_type: 'interval' as const,
    };
  }

  function journalTask() {
    return {
      id: 'soul-evening-journal-main',
      group_folder: 'main',
      schedule_type: 'cron' as const,
    };
  }

  it('skips curation when there are no uncurated entries', async () => {
    await soulCapability.init(ctx());
    const allow = await soulCapability.hooks!.beforeTaskRun!(curationTask());
    expect(allow).toBe(false);
    await soulCapability.teardown!();
  });

  it('allows curation when at least one uncurated entry exists', async () => {
    await soulCapability.init(ctx());
    addMemory(getDb(), {
      groupFolder: 'main',
      timestamp: '2026-04-30T12:00:00Z',
      type: 'observation',
      source: 'whatsapp',
      content: 'real message',
      importance: 5,
    });
    const allow = await soulCapability.hooks!.beforeTaskRun!(curationTask());
    expect(allow).toBe(true);
    await soulCapability.teardown!();
  });

  it('always allows the evening journal regardless of uncurated count', async () => {
    await soulCapability.init(ctx());
    const allow = await soulCapability.hooks!.beforeTaskRun!(journalTask());
    expect(allow).toBe(true);
    await soulCapability.teardown!();
  });

  it('does not gate unrelated tasks', async () => {
    await soulCapability.init(ctx());
    const allow = await soulCapability.hooks!.beforeTaskRun!({
      id: 'task-from-some-other-feature',
      group_folder: 'main',
      schedule_type: 'interval',
    });
    expect(allow).toBe(true);
    await soulCapability.teardown!();
  });

  it('fails open after teardown', async () => {
    await soulCapability.init(ctx());
    await soulCapability.teardown!();
    const allow = await soulCapability.hooks!.beforeTaskRun!(curationTask());
    expect(allow).toBe(true);
  });

  function checkInTask() {
    return {
      id: 'soul-check-in-main',
      group_folder: 'main',
      schedule_type: 'interval' as const,
    };
  }

  function morningPlanTask() {
    return {
      id: 'soul-morning-plan-main',
      group_folder: 'main',
      schedule_type: 'cron' as const,
    };
  }

  function writePlan(
    folder: string,
    dateStr: string,
    items: { type?: string; status?: string }[] = [],
  ): void {
    const soulDir = path.join(tmpDir, folder, 'soul');
    fs.mkdirSync(soulDir, { recursive: true });
    fs.writeFileSync(
      path.join(soulDir, 'daily-plan.json'),
      JSON.stringify({ date: dateStr, items }),
      'utf-8',
    );
  }

  function insertBet(overrides?: {
    id?: string;
    groupFolder?: string;
    status?: string;
    sentAt?: string | null;
    channelMessageId?: string | null;
    windowDays?: number;
  }): string {
    const id =
      overrides?.id ?? `bet-${Math.random().toString(36).slice(2, 10)}`;
    getDb()
      .prepare(
        `INSERT INTO bets (id, group_folder, title, body, status, created_at,
           sent_at, channel_message_id, window_days)
         VALUES (?, ?, 'Test bet', 'Body', ?, datetime('now'), ?, ?, ?)`,
      )
      .run(
        id,
        overrides?.groupFolder ?? 'observability',
        overrides?.status ?? 'proposed',
        overrides?.sentAt ?? null,
        overrides?.channelMessageId ?? null,
        overrides?.windowDays ?? 7,
      );
    return id;
  }

  function writeBudgetFile(
    folder: string,
    payload: {
      date: string;
      messages_sent: number;
      last_message_at: string | null;
    },
  ): void {
    const soulDir = path.join(tmpDir, folder, 'soul');
    fs.mkdirSync(soulDir, { recursive: true });
    fs.writeFileSync(
      path.join(soulDir, 'proactive-budget.json'),
      JSON.stringify(payload),
      'utf-8',
    );
  }

  function todayLocal(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate(),
    ).padStart(2, '0')}`;
  }

  // Helpers to pin the clock so the check-in gate test is deterministic
  // regardless of the wall-clock time the suite runs at.
  function pinClock(at: Date): void {
    // Only fake Date — leave setTimeout/setInterval real so async init/teardown
    // don't deadlock on internal microtasks (e.g. logger flushes).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at);
  }
  function releaseClock(): void {
    vi.useRealTimers();
  }

  it('allows check-in when a proposed bet exists and the budget is fresh', async () => {
    pinClock(new Date(2026, 4, 15, 14, 0, 0)); // May 15, 2026, 2:00 PM local
    try {
      await soulCapability.init(ctx());
      insertBet({ status: 'proposed' });
      writeBudgetFile('main', {
        date: todayLocal(),
        messages_sent: 0,
        last_message_at: null,
      });
      const allow = await soulCapability.hooks!.beforeTaskRun!(checkInTask());
      expect(allow).toBe(true);
      await soulCapability.teardown!();
    } finally {
      releaseClock();
    }
  });

  it('skips check-in when there is nothing to do (no bets, no reminders)', async () => {
    pinClock(new Date(2026, 4, 15, 14, 0, 0));
    try {
      await soulCapability.init(ctx());
      writeBudgetFile('main', {
        date: todayLocal(),
        messages_sent: 0,
        last_message_at: null,
      });
      const allow = await soulCapability.hooks!.beforeTaskRun!(checkInTask());
      expect(allow).toBe(false);
      await soulCapability.teardown!();
    } finally {
      releaseClock();
    }
  });

  it('skips check-in at 11 PM (quiet hours) even with a proposed bet', async () => {
    pinClock(new Date(2026, 4, 15, 23, 0, 0));
    try {
      await soulCapability.init(ctx());
      insertBet({ status: 'proposed' });
      writeBudgetFile('main', {
        date: todayLocal(),
        messages_sent: 0,
        last_message_at: null,
      });
      const allow = await soulCapability.hooks!.beforeTaskRun!(checkInTask());
      expect(allow).toBe(false);
      await soulCapability.teardown!();
    } finally {
      releaseClock();
    }
  });

  it('skips check-in at 5 AM (quiet hours) even with a proposed bet', async () => {
    pinClock(new Date(2026, 4, 15, 5, 0, 0));
    try {
      await soulCapability.init(ctx());
      insertBet({ status: 'proposed' });
      writeBudgetFile('main', {
        date: todayLocal(),
        messages_sent: 0,
        last_message_at: null,
      });
      const allow = await soulCapability.hooks!.beforeTaskRun!(checkInTask());
      expect(allow).toBe(false);
      await soulCapability.teardown!();
    } finally {
      releaseClock();
    }
  });

  it('skips check-in at 2 PM when budget is exhausted, even with a proposed bet', async () => {
    pinClock(new Date(2026, 4, 15, 14, 0, 0));
    try {
      await soulCapability.init(ctx());
      insertBet({ status: 'proposed' });
      writeBudgetFile('main', {
        date: todayLocal(),
        messages_sent: 3, // PROACTIVE_MAX_MESSAGES
        last_message_at: '2000-01-01T00:00:00Z', // well past min gap
      });
      const allow = await soulCapability.hooks!.beforeTaskRun!(checkInTask());
      expect(allow).toBe(false);
      await soulCapability.teardown!();
    } finally {
      releaseClock();
    }
  });

  it('allows check-in for reference resolution when a sent bet awaits and the owner spoke, regardless of budget', async () => {
    pinClock(new Date(2026, 4, 15, 14, 0, 0));
    try {
      await soulCapability.init(ctx());
      insertBet({ status: 'sent', sentAt: new Date().toISOString() });
      // Uncurated owner observation = "the owner said something new".
      addMemory(getDb(), {
        groupFolder: 'main',
        timestamp: new Date().toISOString(),
        type: 'observation',
        source: 'telegram',
        content: 'I tried the Langfuse setup you suggested',
        importance: 5,
      });
      writeBudgetFile('main', {
        date: todayLocal(),
        messages_sent: 3, // exhausted — resolution work is not a send
        last_message_at: '2000-01-01T00:00:00Z',
      });
      const allow = await soulCapability.hooks!.beforeTaskRun!(checkInTask());
      expect(allow).toBe(true);
      await soulCapability.teardown!();
    } finally {
      releaseClock();
    }
  });

  it('skips check-in when a sent bet awaits but the owner has been silent', async () => {
    pinClock(new Date(2026, 4, 15, 14, 0, 0));
    try {
      await soulCapability.init(ctx());
      insertBet({ status: 'sent', sentAt: new Date().toISOString() });
      writeBudgetFile('main', {
        date: todayLocal(),
        messages_sent: 0,
        last_message_at: null,
      });
      const allow = await soulCapability.hooks!.beforeTaskRun!(checkInTask());
      expect(allow).toBe(false);
      await soulCapability.teardown!();
    } finally {
      releaseClock();
    }
  });

  it('expires overdue sent bets host-side during the gate', async () => {
    pinClock(new Date(2026, 4, 15, 14, 0, 0));
    try {
      await soulCapability.init(ctx());
      const overdue = insertBet({
        status: 'sent',
        sentAt: new Date(2026, 4, 1, 12, 0, 0).toISOString(), // 14 days ago
        windowDays: 7,
      });
      writeBudgetFile('main', {
        date: todayLocal(),
        messages_sent: 0,
        last_message_at: null,
      });
      const allow = await soulCapability.hooks!.beforeTaskRun!(checkInTask());
      expect(allow).toBe(false); // nothing left to do once expired
      const row = getDb()
        .prepare('SELECT status, resolution, resolution_source FROM bets WHERE id = ?')
        .get(overdue) as { status: string; resolution: string; resolution_source: string };
      expect(row.status).toBe('expired');
      expect(row.resolution).toBe('expired');
      expect(row.resolution_source).toBe('timeout');
      await soulCapability.teardown!();
    } finally {
      releaseClock();
    }
  });

  it('allows check-in when the plan holds a pending reminder and budget is fresh', async () => {
    pinClock(new Date(2026, 4, 15, 14, 0, 0));
    try {
      await soulCapability.init(ctx());
      writePlan('main', todayLocal(), [
        { type: 'reminder', status: 'pending' },
      ]);
      writeBudgetFile('main', {
        date: todayLocal(),
        messages_sent: 0,
        last_message_at: null,
      });
      const allow = await soulCapability.hooks!.beforeTaskRun!(checkInTask());
      expect(allow).toBe(true);
      await soulCapability.teardown!();
    } finally {
      releaseClock();
    }
  });

  it('check-in gate runs when an acted blog bet has no draft file', async () => {
    pinClock(new Date(2026, 4, 15, 14, 0, 0));
    try {
      await soulCapability.init(ctx());
      getDb()
        .prepare(
          `INSERT INTO bets (id, group_folder, title, body, status, created_at, window_days, resolution, resolved_at)
           VALUES ('blog1', 'main', '📝 Blog: x', 'b', 'resolved', datetime('now'), 7, 'acted', datetime('now'))`,
        )
        .run();
      writeBudgetFile('main', {
        date: todayLocal(),
        messages_sent: 3,
        last_message_at: '2000-01-01T00:00:00Z',
      });
      // no file at groups/main/scout/drafts/blog1.md
      const allow = await soulCapability.hooks!.beforeTaskRun!(checkInTask());
      expect(allow).toBe(true);
      await soulCapability.teardown!();
    } finally {
      releaseClock();
    }
  });

  it('check-in gate does NOT run for an acted blog bet already drafted', async () => {
    pinClock(new Date(2026, 4, 15, 14, 0, 0));
    try {
      await soulCapability.init(ctx());
      getDb()
        .prepare(
          `INSERT INTO bets (id, group_folder, title, body, status, created_at, window_days, resolution, resolved_at)
           VALUES ('blog2', 'main', '📝 Blog: y', 'b', 'resolved', datetime('now'), 7, 'acted', datetime('now'))`,
        )
        .run();
      writeBudgetFile('main', {
        date: todayLocal(),
        messages_sent: 3,
        last_message_at: '2000-01-01T00:00:00Z',
      });
      const dir = path.join(tmpDir, 'main', 'scout', 'drafts');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'blog2.md'), 'done');
      // budget exhausted + no other work → false
      const allow = await soulCapability.hooks!.beforeTaskRun!(checkInTask());
      expect(allow).toBe(false);
      await soulCapability.teardown!();
    } finally {
      releaseClock();
    }
  });

  it('runs the production pass when below bet capacity and skips at capacity', async () => {
    await soulCapability.init(ctx());
    const productionTask = {
      id: 'soul-production-main',
      group_folder: 'main',
      schedule_type: 'cron' as const,
    };
    expect(await soulCapability.hooks!.beforeTaskRun!(productionTask)).toBe(
      true,
    );
    insertBet({ status: 'proposed' });
    insertBet({ status: 'sent', sentAt: new Date().toISOString() });
    insertBet({ status: 'proposed' });
    expect(await soulCapability.hooks!.beforeTaskRun!(productionTask)).toBe(
      false,
    );
    await soulCapability.teardown!();
  });

  it("skips morning plan when today's plan already exists", async () => {
    await soulCapability.init(ctx());
    writePlan('main', todayLocal());
    const allow = await soulCapability.hooks!.beforeTaskRun!(morningPlanTask());
    expect(allow).toBe(false);
    await soulCapability.teardown!();
  });

  it('allows morning plan when no plan exists', async () => {
    await soulCapability.init(ctx());
    const allow = await soulCapability.hooks!.beforeTaskRun!(morningPlanTask());
    expect(allow).toBe(true);
    await soulCapability.teardown!();
  });

  it('allows morning plan when existing plan is from a previous day', async () => {
    await soulCapability.init(ctx());
    writePlan('main', '2000-01-01');
    const allow = await soulCapability.hooks!.beforeTaskRun!(morningPlanTask());
    expect(allow).toBe(true);
    await soulCapability.teardown!();
  });

  it('allows morning plan when the existing plan file is malformed', async () => {
    await soulCapability.init(ctx());
    const soulDir = path.join(tmpDir, 'main', 'soul');
    fs.mkdirSync(soulDir, { recursive: true });
    fs.writeFileSync(
      path.join(soulDir, 'daily-plan.json'),
      '{not valid json',
      'utf-8',
    );
    const allow = await soulCapability.hooks!.beforeTaskRun!(morningPlanTask());
    expect(allow).toBe(true);
    await soulCapability.teardown!();
  });
});

describe('bet ledger: channel events + publish (Phase 6)', () => {
  beforeEach(() => {
    runMigrations(getDb(), soulCapability);
  });

  function insertBet(overrides?: {
    id?: string;
    status?: string;
    sentAt?: string | null;
    channelMessageId?: string | null;
  }): string {
    const id =
      overrides?.id ?? `bet-${Math.random().toString(36).slice(2, 10)}`;
    getDb()
      .prepare(
        `INSERT INTO bets (id, group_folder, title, body, status, created_at,
           sent_at, channel_message_id, window_days)
         VALUES (?, 'observability', 'Test bet', 'Body', ?, datetime('now'), ?, ?, 7)`,
      )
      .run(
        id,
        overrides?.status ?? 'proposed',
        overrides?.sentAt ?? null,
        overrides?.channelMessageId ?? null,
      );
    return id;
  }

  function outboundCtx() {
    const sendMessage = vi.fn().mockResolvedValue('321');
    const setLedger = vi.fn().mockResolvedValue(undefined);
    return {
      ctx: {
        db: getDb(),
        registeredGroups: () => ({
          'main@g.us': { name: 'Main', folder: 'main' },
        }),
        projectRoot: tmpDir,
        groupsDir: tmpDir,
        dataDir: tmpDir,
        sendMessage,
        setLedger,
      },
      sendMessage,
      setLedger,
    };
  }

  it('button tap resolves the bet and refreshes the ledger', async () => {
    const { ctx, setLedger } = outboundCtx();
    await soulCapability.init(ctx);
    const id = insertBet({
      status: 'sent',
      sentAt: new Date().toISOString(),
      channelMessageId: '777',
    });

    soulCapability.hooks!.onChannelEvent!({
      kind: 'button',
      chatJid: 'main@g.us',
      messageId: '777',
      sender: '1',
      senderName: 'Will',
      data: `bet:${id}:acted`,
      timestamp: new Date().toISOString(),
    });

    const row = getDb()
      .prepare('SELECT status, resolution, resolution_source FROM bets WHERE id = ?')
      .get(id) as { status: string; resolution: string; resolution_source: string };
    expect(row.status).toBe('resolved');
    expect(row.resolution).toBe('acted');
    expect(row.resolution_source).toBe('button');
    expect(setLedger).toHaveBeenCalled();

    await soulCapability.teardown!();
  });

  it('ignores non-bet button payloads', async () => {
    const { ctx, setLedger } = outboundCtx();
    await soulCapability.init(ctx);
    const id = insertBet({ status: 'sent', sentAt: new Date().toISOString() });

    soulCapability.hooks!.onChannelEvent!({
      kind: 'button',
      chatJid: 'main@g.us',
      messageId: '777',
      sender: '1',
      senderName: 'Will',
      data: 'unrelated:button',
      timestamp: new Date().toISOString(),
    });

    expect(
      (getDb().prepare('SELECT status FROM bets WHERE id = ?').get(id) as {
        status: string;
      }).status,
    ).toBe('sent');
    expect(setLedger).not.toHaveBeenCalled();
    await soulCapability.teardown!();
  });

  it('👍 reaction on the bet message resolves it as acted; 👎 as rejected', async () => {
    const { ctx } = outboundCtx();
    await soulCapability.init(ctx);
    const up = insertBet({
      status: 'sent',
      sentAt: new Date().toISOString(),
      channelMessageId: '100',
    });
    const down = insertBet({
      status: 'sent',
      sentAt: new Date().toISOString(),
      channelMessageId: '200',
    });

    soulCapability.hooks!.onChannelEvent!({
      kind: 'reaction',
      chatJid: 'main@g.us',
      messageId: '100',
      sender: '1',
      senderName: 'Will',
      emoji: '👍',
      timestamp: new Date().toISOString(),
    });
    soulCapability.hooks!.onChannelEvent!({
      kind: 'reaction',
      chatJid: 'main@g.us',
      messageId: '200',
      sender: '1',
      senderName: 'Will',
      emoji: '👎',
      timestamp: new Date().toISOString(),
    });
    // Irrelevant emoji on an unrelated message — no-op.
    soulCapability.hooks!.onChannelEvent!({
      kind: 'reaction',
      chatJid: 'main@g.us',
      messageId: '300',
      sender: '1',
      senderName: 'Will',
      emoji: '🤔',
      timestamp: new Date().toISOString(),
    });

    const get = (id: string) =>
      getDb().prepare('SELECT resolution FROM bets WHERE id = ?').get(id) as {
        resolution: string | null;
      };
    expect(get(up).resolution).toBe('acted');
    expect(get(down).resolution).toBe('rejected');
    await soulCapability.teardown!();
  });

  it('requestPublishBet sends with buttons, stamps the bet, consumes budget, refreshes ledger', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 4, 15, 14, 0, 0)); // 2 PM local
    try {
      const { ctx, sendMessage, setLedger } = outboundCtx();
      await soulCapability.init(ctx);
      const id = insertBet();

      const result = await requestPublishBet({ betId: id });
      expect(result).toEqual({ ok: true, betId: id });

      expect(sendMessage).toHaveBeenCalledTimes(1);
      const [jid, text, opts] = sendMessage.mock.calls[0];
      expect(jid).toBe('main@g.us');
      expect(text).toContain('🎯 Test bet');
      expect(opts.buttons[0].map((b: { id: string }) => b.id)).toEqual([
        `bet:${id}:acted`,
        `bet:${id}:deferred`,
        `bet:${id}:rejected`,
      ]);

      const row = getDb()
        .prepare('SELECT status, channel_message_id FROM bets WHERE id = ?')
        .get(id) as { status: string; channel_message_id: string };
      expect(row.status).toBe('sent');
      expect(row.channel_message_id).toBe('321');

      const budget = JSON.parse(
        fs.readFileSync(
          path.join(tmpDir, 'main', 'soul', 'proactive-budget.json'),
          'utf-8',
        ),
      ) as { messages_sent: number };
      expect(budget.messages_sent).toBe(1);
      expect(setLedger).toHaveBeenCalled();

      await soulCapability.teardown!();
    } finally {
      vi.useRealTimers();
    }
  });

  it('requestPublishBet refuses during quiet hours', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 4, 15, 23, 0, 0)); // 11 PM local
    try {
      const { ctx, sendMessage } = outboundCtx();
      await soulCapability.init(ctx);
      const id = insertBet();

      const result = await requestPublishBet({ betId: id });
      expect(result.ok).toBe(false);
      expect(sendMessage).not.toHaveBeenCalled();
      expect(
        (getDb().prepare('SELECT status FROM bets WHERE id = ?').get(id) as {
          status: string;
        }).status,
      ).toBe('proposed');

      await soulCapability.teardown!();
    } finally {
      vi.useRealTimers();
    }
  });

  it('requestPublishBet refuses unknown and non-proposed bets', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 4, 15, 14, 0, 0));
    try {
      const { ctx, sendMessage } = outboundCtx();
      await soulCapability.init(ctx);

      expect((await requestPublishBet({ betId: 'nope' })).ok).toBe(false);

      const sent = insertBet({
        status: 'sent',
        sentAt: new Date().toISOString(),
      });
      expect((await requestPublishBet({ betId: sent })).ok).toBe(false);
      expect(sendMessage).not.toHaveBeenCalled();

      await soulCapability.teardown!();
    } finally {
      vi.useRealTimers();
    }
  });

  it('requestPublishBet errors cleanly when the capability is not initialized', async () => {
    const result = await requestPublishBet({ betId: 'x' });
    expect(result.ok).toBe(false);
  });
});

describe('bet-store: getActedBlogBets', () => {
  beforeEach(() => {
    runMigrations(getDb(), soulCapability);
  });

  it('getActedBlogBets returns only resolved+acted blog bets', () => {
    const db = getDb();
    const ins = (
      id: string,
      title: string,
      status: string,
      resolution: string | null,
    ) =>
      db
        .prepare(
          `INSERT INTO bets (id, group_folder, title, body, status, created_at, window_days, resolution)
           VALUES (?, 'main', ?, 'b', ?, datetime('now'), 7, ?)`,
        )
        .run(id, title, status, resolution);
    ins('a', '📝 Blog: topic one', 'resolved', 'acted');
    ins('b', '📝 Blog: topic two', 'resolved', 'rejected');
    ins('c', '🎯 normal bet', 'resolved', 'acted');
    ins('d', '📝 Blog: topic three', 'sent', null);

    const result = getActedBlogBets(db).map((x) => x.id);
    expect(result).toEqual(['a']);
  });
});

describe('planning-prompts', () => {
  it('buildMorningPlanPrompt substitutes the folder into the DB query', async () => {
    const { buildMorningPlanPrompt } = await import('./planning-prompts.js');
    const prompt = buildMorningPlanPrompt('weirdfolder');
    expect(prompt).toContain("group_folder = 'weirdfolder'");
    expect(prompt).toContain('daily-plan.json');
    expect(prompt.length).toBeGreaterThan(200);
  });

  it('buildCheckInPrompt substitutes the folder into the intervention insert', async () => {
    const { buildCheckInPrompt } = await import('./planning-prompts.js');
    const prompt = buildCheckInPrompt('weirdfolder');
    expect(prompt).toContain("'weirdfolder'");
    expect(prompt).toContain('proactive-budget.json');
    expect(prompt.length).toBeGreaterThan(200);
  });

  it('check-in prompt instructs blog-draft assembly + send_document', async () => {
    const { buildCheckInPrompt } = await import('./planning-prompts.js');
    const prompt = buildCheckInPrompt('main');
    expect(prompt).toContain('scout/drafts/');
    expect(prompt).toContain('send_document');
    expect(prompt).toContain('VERIFY BEFORE PUBLISHING');
  });
});

describe('ensureClaudeMdSection', () => {
  beforeEach(() => {
    runMigrations(getDb(), soulCapability);
  });

  it('creates CLAUDE.md with soul section when no file exists', async () => {
    await soulCapability.init({
      db: getDb(),
      registeredGroups: () => ({
        'g@g.us': { name: 'Main', folder: 'main' },
      }),
      projectRoot: tmpDir,
      groupsDir: tmpDir,
      dataDir: tmpDir,
    });

    const claudePath = path.join(tmpDir, 'main', 'CLAUDE.md');
    expect(fs.existsSync(claudePath)).toBe(true);
    const contents = fs.readFileSync(claudePath, 'utf-8');
    expect(contents).toContain('<!-- soul-section -->');
    expect(contents).toContain('## Soul');

    await soulCapability.teardown!();
  });

  it('appends soul section to existing CLAUDE.md', async () => {
    fs.mkdirSync(path.join(tmpDir, 'main'), { recursive: true });
    const claudePath = path.join(tmpDir, 'main', 'CLAUDE.md');
    fs.writeFileSync(claudePath, '# Andy\n\nExisting content here.\n', 'utf-8');

    await soulCapability.init({
      db: getDb(),
      registeredGroups: () => ({
        'g@g.us': { name: 'Main', folder: 'main' },
      }),
      projectRoot: tmpDir,
      groupsDir: tmpDir,
      dataDir: tmpDir,
    });

    const contents = fs.readFileSync(claudePath, 'utf-8');
    expect(contents).toMatch(/^# Andy\n\nExisting content here\.\n/);
    expect(contents).toContain('<!-- soul-section -->');
    expect(contents).toContain('## Soul');

    await soulCapability.teardown!();
  });

  it('does not duplicate the soul section on re-init', async () => {
    const ctx = {
      db: getDb(),
      registeredGroups: () => ({
        'g@g.us': { name: 'Main', folder: 'main' },
      }),
      projectRoot: tmpDir,
      groupsDir: tmpDir,
      dataDir: tmpDir,
    };
    await soulCapability.init(ctx);
    await soulCapability.teardown!();
    await soulCapability.init(ctx);

    const contents = fs.readFileSync(
      path.join(tmpDir, 'main', 'CLAUDE.md'),
      'utf-8',
    );
    const matches = contents.match(/<!-- soul-section -->/g) ?? [];
    expect(matches).toHaveLength(1);
    // Closing marker also appears exactly once.
    const endMatches = contents.match(/<!-- \/soul-section -->/g) ?? [];
    expect(endMatches).toHaveLength(1);

    await soulCapability.teardown!();
  });

  it('migrates a legacy soul section (no closing marker) by rewriting through EOF', async () => {
    // Pre-Phase-4 files captured only the opening marker and let the section
    // run to EOF. The new ensureClaudeMdSection should overwrite that block
    // with the current section content while preserving the prefix.
    fs.mkdirSync(path.join(tmpDir, 'main'), { recursive: true });
    const claudePath = path.join(tmpDir, 'main', 'CLAUDE.md');
    fs.writeFileSync(
      claudePath,
      '# Andy\n\nProject docs.\n\n<!-- soul-section -->\n## Soul\n\nOld stale soul content.\n',
      'utf-8',
    );

    await soulCapability.init({
      db: getDb(),
      registeredGroups: () => ({
        'g@g.us': { name: 'Main', folder: 'main' },
      }),
      projectRoot: tmpDir,
      groupsDir: tmpDir,
      dataDir: tmpDir,
    });

    const contents = fs.readFileSync(claudePath, 'utf-8');
    expect(contents.startsWith('# Andy\n\nProject docs.')).toBe(true);
    expect(contents).not.toContain('Old stale soul content.');
    expect(contents).toContain('daily-plan.json'); // current Phase 4 wording
    expect(contents).toContain('<!-- /soul-section -->'); // end marker added on migration

    await soulCapability.teardown!();
  });

  it('replaces a paired-marker soul section while preserving surrounding text', async () => {
    fs.mkdirSync(path.join(tmpDir, 'main'), { recursive: true });
    const claudePath = path.join(tmpDir, 'main', 'CLAUDE.md');
    fs.writeFileSync(
      claudePath,
      '# Andy\n\nPrefix.\n\n<!-- soul-section -->\nStale.\n<!-- /soul-section -->\n\n# Footer\n',
      'utf-8',
    );

    await soulCapability.init({
      db: getDb(),
      registeredGroups: () => ({
        'g@g.us': { name: 'Main', folder: 'main' },
      }),
      projectRoot: tmpDir,
      groupsDir: tmpDir,
      dataDir: tmpDir,
    });

    const contents = fs.readFileSync(claudePath, 'utf-8');
    expect(contents.startsWith('# Andy\n\nPrefix.')).toBe(true);
    expect(contents).toContain('# Footer'); // suffix intact
    expect(contents).not.toContain('Stale.');
    expect(contents).toContain('## Soul');
    expect(contents).toContain('daily-plan.json');

    await soulCapability.teardown!();
  });

  it('is a no-op when CLAUDE.md already has the current soul section', async () => {
    // First init writes the section; record mtime. Second init should not
    // touch the file because the proposed content equals existing content.
    const ctx = {
      db: getDb(),
      registeredGroups: () => ({
        'g@g.us': { name: 'Main', folder: 'main' },
      }),
      projectRoot: tmpDir,
      groupsDir: tmpDir,
      dataDir: tmpDir,
    };
    await soulCapability.init(ctx);
    await soulCapability.teardown!();

    const claudePath = path.join(tmpDir, 'main', 'CLAUDE.md');
    const firstMtime = fs.statSync(claudePath).mtimeMs;
    // Sleep a touch so mtime granularity (1ms on most fs, but coarser on some)
    // can distinguish a write from a no-op.
    await new Promise((r) => setTimeout(r, 20));

    await soulCapability.init(ctx);
    await soulCapability.teardown!();
    const secondMtime = fs.statSync(claudePath).mtimeMs;
    expect(secondMtime).toBe(firstMtime);
  });

  it('does not touch CLAUDE.md when no main group is registered', async () => {
    await soulCapability.init({
      db: getDb(),
      registeredGroups: () => ({
        'g@g.us': { name: 'Side', folder: 'side' },
      }),
      projectRoot: tmpDir,
      groupsDir: tmpDir,
      dataDir: tmpDir,
    });

    expect(fs.existsSync(path.join(tmpDir, 'main', 'CLAUDE.md'))).toBe(false);

    await soulCapability.teardown!();
  });
});

describe('encodeMultibase', () => {
  it('produces a "z" prefix for base58btc', () => {
    const out = encodeMultibase(new Uint8Array([0, 0, 1, 2, 3]));
    expect(out.startsWith('z')).toBe(true);
  });

  it('encodes empty bytes as just the prefix', () => {
    expect(encodeMultibase(new Uint8Array([]))).toBe('z');
  });

  it('handles a known Ed25519-sized input deterministically', () => {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = i;
    const a = encodeMultibase(bytes);
    const b = encodeMultibase(bytes);
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(40);
  });
});

describe('encodeEd25519PublicKeyMultibase', () => {
  it('produces a "z6Mk" prefix for a real Ed25519 public key', () => {
    // Properly multicodec-prefixed (0xed 0x01) Ed25519 keys encoded as
    // base58btc multibase always start with "z6Mk". This is the canonical
    // Ed25519VerificationKey2020 publicKeyMultibase format that DID/W3C
    // verifiers expect — if this assertion ever fails, the multicodec prefix
    // has been dropped or the encoding broke.
    const keyDir = path.join(tmpDir, 'keys');
    generateKeypair(keyDir);
    const { publicKeyRaw } = loadKeypair(keyDir);
    const mb = encodeEd25519PublicKeyMultibase(publicKeyRaw);
    expect(mb.startsWith('z6Mk')).toBe(true);
  });

  it('produces a "z6Mk" prefix for a deterministic 32-byte input', () => {
    // Independent of generateKeypair — any 32-byte buffer prefixed with
    // 0xed 0x01 and base58btc-encoded yields "z6Mk...".
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = i;
    expect(encodeEd25519PublicKeyMultibase(bytes).startsWith('z6Mk')).toBe(
      true,
    );
  });

  it('is deterministic for the same input', () => {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = i + 1;
    expect(encodeEd25519PublicKeyMultibase(bytes)).toBe(
      encodeEd25519PublicKeyMultibase(bytes),
    );
  });

  it('throws on inputs that are not 32 bytes', () => {
    expect(() => encodeEd25519PublicKeyMultibase(new Uint8Array(31))).toThrow(
      /32 bytes/,
    );
    expect(() => encodeEd25519PublicKeyMultibase(new Uint8Array(33))).toThrow(
      /32 bytes/,
    );
    expect(() => encodeEd25519PublicKeyMultibase(new Uint8Array(0))).toThrow(
      /32 bytes/,
    );
  });

  it('differs from the unprefixed multibase encoding of the same key', () => {
    // Sanity check that the multicodec prefix actually changes the output —
    // a regression where the prefix is silently dropped should fail here.
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = i;
    expect(encodeEd25519PublicKeyMultibase(bytes)).not.toBe(
      encodeMultibase(bytes),
    );
  });
});

describe('identity keys', () => {
  it('generateKeypair writes PEM files with correct permissions', () => {
    const keyDir = path.join(tmpDir, 'keys');
    generateKeypair(keyDir);
    const privPath = path.join(keyDir, 'private-key.pem');
    const pubPath = path.join(keyDir, 'public-key.pem');
    expect(fs.existsSync(privPath)).toBe(true);
    expect(fs.existsSync(pubPath)).toBe(true);
    expect(fs.readFileSync(privPath, 'utf-8')).toContain('PRIVATE KEY');
    expect(fs.readFileSync(pubPath, 'utf-8')).toContain('PUBLIC KEY');
    if (process.platform !== 'win32') {
      const mode = fs.statSync(privPath).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it('generateKeypair is idempotent', () => {
    const keyDir = path.join(tmpDir, 'keys');
    generateKeypair(keyDir);
    const before = fs.readFileSync(
      path.join(keyDir, 'private-key.pem'),
      'utf-8',
    );
    generateKeypair(keyDir);
    const after = fs.readFileSync(
      path.join(keyDir, 'private-key.pem'),
      'utf-8',
    );
    expect(after).toBe(before);
  });

  it('loadKeypair returns objects compatible with crypto.sign', () => {
    const keyDir = path.join(tmpDir, 'keys');
    generateKeypair(keyDir);
    const { privateKey, publicKey, publicKeyRaw } = loadKeypair(keyDir);
    const message = Buffer.from('hello soul');
    const sig = crypto.sign(null, message, privateKey);
    const ok = crypto.verify(null, message, publicKey, sig);
    expect(ok).toBe(true);
    expect(publicKeyRaw).toHaveLength(32);
  });

  it('loadKeypair throws when keys do not exist', () => {
    expect(() => loadKeypair(path.join(tmpDir, 'nope'))).toThrow(/not found/i);
  });
});

describe('generateDIDDocument', () => {
  it('returns the expected structure', () => {
    const doc = generateDIDDocument({
      domain: 'example.ts.net',
      agentName: 'Andy',
      publicKeyMultibase: 'z6Mk-test',
    }) as Record<string, unknown>;
    const did = 'did:wba:example.ts.net:agent:Andy';
    expect(doc.id).toBe(did);
    const vm = doc.verificationMethod as Array<{
      id: string;
      type: string;
      controller: string;
      publicKeyMultibase: string;
    }>;
    expect(vm[0].id).toBe(`${did}#key-1`);
    expect(vm[0].type).toBe('Ed25519VerificationKey2020');
    expect(vm[0].controller).toBe(did);
    expect(vm[0].publicKeyMultibase).toBe('z6Mk-test');
    expect(doc.authentication).toEqual([`${did}#key-1`]);
    const services = doc.service as Array<{
      id: string;
      serviceEndpoint: string;
    }>;
    expect(services.find((s) => s.id === '#a2a')!.serviceEndpoint).toBe(
      'https://example.ts.net/a2a',
    );
  });
});

describe('signDocument', () => {
  it('produces a signature verifiable with the public key', () => {
    const keyDir = path.join(tmpDir, 'keys');
    generateKeypair(keyDir);
    const { privateKey, publicKey } = loadKeypair(keyDir);
    const doc = { id: 'did:wba:x:agent:y', name: 'Andy' };
    const signed = signDocument(doc, privateKey, 'did:wba:x:agent:y#key-1');
    const sig = signed['anp:signature'];
    expect(sig.type).toBe('Ed25519Signature2020');
    expect(sig.verificationMethod).toBe('did:wba:x:agent:y#key-1');

    const { 'anp:signature': _omit, ...unsigned } = signed;
    void _omit;
    const canonical = JSON.stringify(
      Object.keys(unsigned)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = (unsigned as Record<string, unknown>)[k];
          return acc;
        }, {}),
    );
    const ok = crypto.verify(
      null,
      Buffer.from(canonical, 'utf-8'),
      publicKey,
      Buffer.from(sig.proofValue, 'base64url'),
    );
    expect(ok).toBe(true);
  });

  it('strips an existing signature before re-signing', () => {
    const keyDir = path.join(tmpDir, 'keys');
    generateKeypair(keyDir);
    const { privateKey } = loadKeypair(keyDir);
    const first = signDocument({ name: 'A' }, privateKey, 'vm-1');
    const second = signDocument(first, privateKey, 'vm-1');
    expect(second['anp:signature'].proofValue).toBeTruthy();
    expect(
      Object.keys(second).filter((k) => k === 'anp:signature'),
    ).toHaveLength(1);
  });
});

describe('discoverCapabilities', () => {
  it('maps each channel to a {channel}-messaging capability', () => {
    const caps = discoverCapabilities({
      channelNames: ['whatsapp', 'telegram'],
      skillNames: [],
      hasScheduler: false,
    });
    expect(caps.find((c) => c.name === 'whatsapp-messaging')).toBeDefined();
    expect(caps.find((c) => c.name === 'telegram-messaging')).toBeDefined();
  });

  it('includes scheduling only when hasScheduler is true', () => {
    const without = discoverCapabilities({
      channelNames: [],
      skillNames: [],
      hasScheduler: false,
    });
    const withSched = discoverCapabilities({
      channelNames: [],
      skillNames: [],
      hasScheduler: true,
    });
    expect(without.find((c) => c.name === 'scheduling')).toBeUndefined();
    expect(withSched.find((c) => c.name === 'scheduling')).toBeDefined();
  });

  it('emits a skill: prefix for each skill', () => {
    const caps = discoverCapabilities({
      channelNames: [],
      skillNames: ['add-soul', 'add-telegram'],
      hasScheduler: false,
    });
    expect(caps.find((c) => c.name === 'skill:add-soul')).toBeDefined();
    expect(caps.find((c) => c.name === 'skill:add-telegram')).toBeDefined();
  });
});

describe('generateAgentDescription', () => {
  it('embeds DID, owner, capabilities, and on-chain placeholder', () => {
    const desc = generateAgentDescription({
      domain: 'example.ts.net',
      agentName: 'Andy',
      owner: 'Will',
      channelNames: ['whatsapp'],
      skillNames: ['add-soul'],
      hasScheduler: true,
      now: new Date('2026-05-02T12:00:00Z'),
    }) as Record<string, unknown>;
    expect(desc.identifier).toBe('did:wba:example.ts.net:agent:Andy');
    expect((desc.owner as { name: string }).name).toBe('Will');
    expect(desc['anp:lastSeen']).toBe('2026-05-02T12:00:00.000Z');
    expect(desc['anp:verificationLevels']).toEqual([
      'cryptographic',
      'owner-verified',
    ]);
    const onChain = desc['anp:onChainIdentity'] as {
      chain: null | string;
      agentId: null | string;
    };
    expect(onChain.chain).toBeNull();
    expect(onChain.agentId).toBeNull();
    const caps = desc['anp:capabilities'] as Array<{ name: string }>;
    expect(caps.find((c) => c.name === 'whatsapp-messaging')).toBeDefined();
    expect(caps.find((c) => c.name === 'scheduling')).toBeDefined();
    expect(caps.find((c) => c.name === 'skill:add-soul')).toBeDefined();
  });

  it('includes anp:traits only when provided', () => {
    const without = generateAgentDescription({
      domain: 'd',
      agentName: 'a',
      owner: 'o',
      channelNames: [],
      skillNames: [],
      hasScheduler: false,
    }) as Record<string, unknown>;
    const withTraits = generateAgentDescription({
      domain: 'd',
      agentName: 'a',
      owner: 'o',
      traits: ['curious', 'helpful'],
      channelNames: [],
      skillNames: [],
      hasScheduler: false,
    }) as Record<string, unknown>;
    expect('anp:traits' in without).toBe(false);
    expect(withTraits['anp:traits']).toEqual(['curious', 'helpful']);
  });
});

describe('identity server', () => {
  let server: http.Server;
  let port: number;

  function freePort(): number {
    // Pick from the user-port range; tests run in single process so 0 collisions.
    return 18000 + Math.floor(Math.random() * 1000);
  }

  async function fetchJson(p: string): Promise<{
    status: number;
    headers: http.IncomingHttpHeaders;
    body: string;
  }> {
    return new Promise((resolve, reject) => {
      http
        .request(
          {
            hostname: '127.0.0.1',
            port,
            path: p,
            method: p === '/a2a' ? 'POST' : 'GET',
          },
          (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () =>
              resolve({
                status: res.statusCode ?? 0,
                headers: res.headers,
                body,
              }),
            );
          },
        )
        .on('error', reject)
        .end();
    });
  }

  beforeEach(() => {
    const keyDir = path.join(tmpDir, 'keys');
    generateKeypair(keyDir);
    const { privateKey } = loadKeypair(keyDir);
    port = freePort();
    server = startIdentityServer({
      port,
      didDocument: generateDIDDocument({
        domain: 'example.ts.net',
        agentName: 'Andy',
        publicKeyMultibase: 'z6Mk-test',
      }),
      agentDescription: generateAgentDescription({
        domain: 'example.ts.net',
        agentName: 'Andy',
        owner: 'Will',
        channelNames: ['whatsapp'],
        skillNames: [],
        hasScheduler: true,
      }),
      privateKey,
      verificationMethodId: 'did:wba:example.ts.net:agent:Andy#key-1',
    });
    return new Promise<void>((resolve) =>
      server.once('listening', () => resolve()),
    );
  });

  afterEach(async () => {
    if (server.listening) await stopIdentityServer(server);
  });

  it('serves a signed DID document at /.well-known/did.json', async () => {
    const res = await fetchJson('/.well-known/did.json');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/did+json');
    const doc = JSON.parse(res.body);
    expect(doc.id).toBe('did:wba:example.ts.net:agent:Andy');
    expect(doc['anp:signature']).toBeDefined();
    expect(doc['anp:signature'].type).toBe('Ed25519Signature2020');
  });

  it('serves a fresh-signed agent description at /.well-known/agent-description.json', async () => {
    const a = await fetchJson('/.well-known/agent-description.json');
    expect(a.status).toBe(200);
    expect(a.headers['content-type']).toBe('application/ld+json');
    const docA = JSON.parse(a.body);
    expect(docA['anp:lastSeen']).toBeDefined();
    // A second hit re-signs with a fresher lastSeen
    await new Promise((r) => setTimeout(r, 5));
    const b = await fetchJson('/.well-known/agent-description.json');
    const docB = JSON.parse(b.body);
    expect(docB['anp:lastSeen'] >= docA['anp:lastSeen']).toBe(true);
  });

  it('returns 200 on /health with the DID', async () => {
    const res = await fetchJson('/health');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('ok');
    expect(body.did).toBe('did:wba:example.ts.net:agent:Andy');
  });

  it('returns 501 on POST /a2a', async () => {
    const res = await fetchJson('/a2a');
    expect(res.status).toBe(501);
  });

  it('returns 404 on unknown routes', async () => {
    const res = await fetchJson('/nope');
    expect(res.status).toBe(404);
  });

  it('sets CORS allow-origin', async () => {
    const res = await fetchJson('/health');
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });
});

describe('soulCapability identity integration', () => {
  beforeEach(() => {
    runMigrations(getDb(), soulCapability);
  });

  it('does not start identity server when SOUL_DOMAIN is unset', async () => {
    const prevDomain = process.env.SOUL_DOMAIN;
    delete process.env.SOUL_DOMAIN;
    try {
      await soulCapability.init({
        db: getDb(),
        registeredGroups: () => ({}),
        projectRoot: tmpDir,
        groupsDir: tmpDir,
        dataDir: tmpDir,
      });
      // No way to assert the absence directly without leaking state, but the
      // teardown should be a no-op (i.e. not throw).
      await soulCapability.teardown!();
    } finally {
      if (prevDomain !== undefined) process.env.SOUL_DOMAIN = prevDomain;
    }
  });
});

describe('readBudget', () => {
  function writeBudget(folder: string, budget: ProactiveBudget): void {
    const soulDir = path.join(tmpDir, folder, 'soul');
    fs.mkdirSync(soulDir, { recursive: true });
    fs.writeFileSync(
      path.join(soulDir, 'proactive-budget.json'),
      JSON.stringify(budget),
      'utf-8',
    );
  }

  it('returns a fresh budget when the file does not exist', () => {
    const now = new Date(2026, 4, 15, 14, 0, 0); // May 15, 2026, 2:00 PM local
    const b = readBudget(tmpDir, 'main', now);
    expect(b.date).toBe('2026-05-15');
    expect(b.messages_sent).toBe(0);
    expect(b.last_message_at).toBeNull();
  });

  it('returns the on-disk budget when the file is for today', () => {
    const now = new Date(2026, 4, 15, 14, 0, 0);
    writeBudget('main', {
      date: '2026-05-15',
      messages_sent: 2,
      last_message_at: '2026-05-15T13:00:00Z',
    });
    const b = readBudget(tmpDir, 'main', now);
    expect(b.messages_sent).toBe(2);
    expect(b.last_message_at).toBe('2026-05-15T13:00:00Z');
  });

  it('resets to a fresh budget when the file is from a previous day', () => {
    const now = new Date(2026, 4, 15, 9, 0, 0);
    writeBudget('main', {
      date: '2026-05-14',
      messages_sent: 3,
      last_message_at: '2026-05-14T21:00:00Z',
    });
    const b = readBudget(tmpDir, 'main', now);
    expect(b.date).toBe('2026-05-15');
    expect(b.messages_sent).toBe(0);
    expect(b.last_message_at).toBeNull();
  });

  it('returns a fresh budget when the file is malformed JSON', () => {
    const soulDir = path.join(tmpDir, 'main', 'soul');
    fs.mkdirSync(soulDir, { recursive: true });
    fs.writeFileSync(
      path.join(soulDir, 'proactive-budget.json'),
      '{not valid json',
      'utf-8',
    );
    const now = new Date(2026, 4, 15, 14, 0, 0);
    const b = readBudget(tmpDir, 'main', now);
    expect(b.messages_sent).toBe(0);
    expect(b.date).toBe('2026-05-15');
  });

  it('returns a fresh budget when the file is missing required fields', () => {
    const soulDir = path.join(tmpDir, 'main', 'soul');
    fs.mkdirSync(soulDir, { recursive: true });
    fs.writeFileSync(
      path.join(soulDir, 'proactive-budget.json'),
      JSON.stringify({ date: '2026-05-15' }), // no messages_sent
      'utf-8',
    );
    const now = new Date(2026, 4, 15, 14, 0, 0);
    expect(readBudget(tmpDir, 'main', now).messages_sent).toBe(0);
  });
});

describe('canSendProactive', () => {
  // Mid-afternoon — well clear of quiet hours.
  const activeHour = new Date(2026, 4, 15, 14, 0, 0);

  it('returns true when fresh budget and active hours', () => {
    const budget: ProactiveBudget = {
      date: '2026-05-15',
      messages_sent: 0,
      last_message_at: null,
    };
    expect(canSendProactive(budget, activeHour)).toBe(true);
  });

  it('returns false during quiet hours (after PROACTIVE_QUIET_START)', () => {
    const lateNight = new Date(2026, 4, 15, 22, 30, 0); // 10:30 PM
    expect(
      canSendProactive(
        { date: '2026-05-15', messages_sent: 0, last_message_at: null },
        lateNight,
      ),
    ).toBe(false);
  });

  it('returns false during quiet hours (before PROACTIVE_QUIET_END)', () => {
    const earlyMorning = new Date(2026, 4, 15, 5, 0, 0); // 5:00 AM
    expect(
      canSendProactive(
        { date: '2026-05-15', messages_sent: 0, last_message_at: null },
        earlyMorning,
      ),
    ).toBe(false);
  });

  it('returns true at the very edge of the active window', () => {
    // 7:00 AM is the first active minute (QUIET_END is exclusive)
    const justOpened = new Date(2026, 4, 15, 7, 0, 0);
    expect(
      canSendProactive(
        { date: '2026-05-15', messages_sent: 0, last_message_at: null },
        justOpened,
      ),
    ).toBe(true);
  });

  it('returns false when daily cap is reached', () => {
    expect(
      canSendProactive(
        {
          date: '2026-05-15',
          messages_sent: PROACTIVE_MAX_MESSAGES,
          last_message_at: '2026-05-15T08:00:00Z',
        },
        activeHour,
      ),
    ).toBe(false);
  });

  it('returns false when last message is within the minimum gap', () => {
    const tooSoon = new Date(
      activeHour.getTime() - (PROACTIVE_MIN_GAP_MS - 60_000),
    );
    expect(
      canSendProactive(
        {
          date: '2026-05-15',
          messages_sent: 1,
          last_message_at: tooSoon.toISOString(),
        },
        activeHour,
      ),
    ).toBe(false);
  });

  it('returns true when the gap since last message has elapsed', () => {
    const longAgo = new Date(
      activeHour.getTime() - (PROACTIVE_MIN_GAP_MS + 60_000),
    );
    expect(
      canSendProactive(
        {
          date: '2026-05-15',
          messages_sent: 1,
          last_message_at: longAgo.toISOString(),
        },
        activeHour,
      ),
    ).toBe(true);
  });

  it('returns false on a future last_message_at (clock skew is conservative)', () => {
    const future = new Date(activeHour.getTime() + 60 * 60 * 1000); // +1h
    expect(
      canSendProactive(
        {
          date: '2026-05-15',
          messages_sent: 1,
          last_message_at: future.toISOString(),
        },
        activeHour,
      ),
    ).toBe(false);
  });

  it('returns false on unparseable last_message_at', () => {
    expect(
      canSendProactive(
        {
          date: '2026-05-15',
          messages_sent: 1,
          last_message_at: 'definitely-not-a-date',
        },
        activeHour,
      ),
    ).toBe(false);
  });
});

describe('armForHour', () => {
  it('maps boundary hours to the correct arms', () => {
    expect(armForHour(7)).toBe('morning');
    expect(armForHour(11)).toBe('morning');
    expect(armForHour(12)).toBe('afternoon');
    expect(armForHour(16)).toBe('afternoon');
    expect(armForHour(17)).toBe('evening');
    expect(armForHour(21)).toBe('evening');
  });

  it('returns null inside quiet hours and other invalid inputs', () => {
    expect(armForHour(22)).toBe(null);
    expect(armForHour(23)).toBe(null);
    expect(armForHour(0)).toBe(null);
    expect(armForHour(3)).toBe(null);
    expect(armForHour(6)).toBe(null);
    expect(armForHour(-1)).toBe(null);
    expect(armForHour(24)).toBe(null);
    expect(armForHour(7.5)).toBe(null);
  });
});

describe('posteriorFor', () => {
  it('adds successes and failures to the prior', () => {
    const p = posteriorFor('morning', 4, 1);
    expect(p.alpha).toBe(TIMING_ARM_PRIORS.morning.alpha + 4);
    expect(p.beta).toBe(TIMING_ARM_PRIORS.morning.beta + 1);
  });

  it('returns the prior unchanged with zero counts', () => {
    for (const arm of TIMING_ARMS) {
      expect(posteriorFor(arm, 0, 0)).toEqual(TIMING_ARM_PRIORS[arm]);
    }
  });
});

describe('sampleBeta', () => {
  it('is deterministic given a fixed RNG and lies in [0, 1]', () => {
    const draw1 = sampleBeta({ alpha: 3, beta: 2 }, seededRng(42));
    const draw2 = sampleBeta({ alpha: 3, beta: 2 }, seededRng(42));
    expect(draw1).toBe(draw2);
    expect(draw1).toBeGreaterThanOrEqual(0);
    expect(draw1).toBeLessThanOrEqual(1);
  });

  it('has empirical mean ≈ alpha/(alpha+beta) over many draws', () => {
    const p: BetaPosterior = { alpha: 4, beta: 6 };
    const rng = seededRng(123);
    const N = 5000;
    let sum = 0;
    for (let i = 0; i < N; i++) sum += sampleBeta(p, rng);
    const mean = sum / N;
    // Expected = 0.4. Std of beta(4,6) ≈ 0.148; SE over 5k draws ≈ 0.0021.
    // 0.03 tolerance is well outside noise but catches gross bias.
    expect(Math.abs(mean - 0.4)).toBeLessThan(0.03);
  });
});

describe('thompsonRanking', () => {
  it('returns all three arms', () => {
    const ranking = thompsonRanking(
      {
        morning: TIMING_ARM_PRIORS.morning,
        afternoon: TIMING_ARM_PRIORS.afternoon,
        evening: TIMING_ARM_PRIORS.evening,
      },
      seededRng(7),
    );
    expect(ranking.length).toBe(3);
    expect(new Set(ranking)).toEqual(
      new Set<TimingArm>(['morning', 'afternoon', 'evening']),
    );
  });

  it('is deterministic given a fixed RNG', () => {
    const posteriors = {
      morning: { alpha: 5, beta: 3 },
      afternoon: { alpha: 2, beta: 4 },
      evening: { alpha: 6, beta: 2 },
    };
    const r1 = thompsonRanking(posteriors, seededRng(99));
    const r2 = thompsonRanking(posteriors, seededRng(99));
    expect(r1).toEqual(r2);
  });

  it('puts a dominant arm first in the large majority of draws', () => {
    // Evening is overwhelming; morning/afternoon barely-prior.
    const posteriors = {
      morning: { alpha: 2, beta: 8 },
      afternoon: { alpha: 2, beta: 8 },
      evening: { alpha: 20, beta: 2 },
    };
    const rng = seededRng(2026);
    let eveningWins = 0;
    const trials = 500;
    for (let i = 0; i < trials; i++) {
      if (thompsonRanking(posteriors, rng)[0] === 'evening') eveningWins++;
    }
    expect(eveningWins / trials).toBeGreaterThan(0.9);
  });
});

// --- Phase 4.5 experiment store ---

interface InsertEpisodeOpts {
  groupFolder?: string;
  timingArm?: TimingArm;
  sentAt?: string;
  outcome?: 'replied' | 'ignored' | 'withdrawn';
  sentiment?: 'positive' | 'neutral' | 'negative' | null;
  target?: string;
  planItemId?: string;
}

function insertEpisode(opts: InsertEpisodeOpts = {}): void {
  const sentAt = opts.sentAt ?? '2026-05-20T10:00:00.000Z';
  getDb()
    .prepare(
      `INSERT INTO experiment_episodes
         (id, group_folder, plan_item_id, target, timing_arm, sent_at,
          message_excerpt, outcome, sentiment, proximal_window_min, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      crypto.randomUUID(),
      opts.groupFolder ?? 'main',
      opts.planItemId ?? null,
      opts.target ?? 'Alice',
      opts.timingArm ?? 'morning',
      sentAt,
      'hello world',
      opts.outcome ?? 'replied',
      opts.sentiment ?? 'positive',
      90,
      sentAt,
    );
}

function insertTuning(opts: {
  version: number;
  stateJson: string;
  baselineEfficacy: number | null;
  createdAt: string;
  active?: 0 | 1;
}): void {
  getDb()
    .prepare(
      `INSERT INTO experiment_tuning
         (id, group_folder, version, state_json, baseline_efficacy, created_at, active)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      crypto.randomUUID(),
      'main',
      opts.version,
      opts.stateJson,
      opts.baselineEfficacy,
      opts.createdAt,
      opts.active ?? 1,
    );
}

describe('experiment-store: getRecentEpisodes', () => {
  beforeEach(() => {
    runMigrations(getDb(), soulCapability);
  });

  it('returns only episodes within the window, newest first', () => {
    const now = new Date('2026-05-20T12:00:00Z');
    insertEpisode({ sentAt: '2026-05-19T12:00:00.000Z' }); // 1 day ago
    insertEpisode({ sentAt: '2026-04-15T12:00:00.000Z' }); // 35 days ago — out
    insertEpisode({ sentAt: '2026-05-20T11:00:00.000Z' }); // 1 hour ago

    const eps = getRecentEpisodes(getDb(), 'main', 30, now);
    expect(eps.length).toBe(2);
    expect(new Date(eps[0].sentAt).getTime()).toBeGreaterThan(
      new Date(eps[1].sentAt).getTime(),
    );
  });

  it('partitions by group_folder', () => {
    const now = new Date('2026-05-20T12:00:00Z');
    insertEpisode({ groupFolder: 'main', sentAt: '2026-05-19T12:00:00.000Z' });
    insertEpisode({ groupFolder: 'other', sentAt: '2026-05-19T12:00:00.000Z' });

    expect(getRecentEpisodes(getDb(), 'main', 30, now).length).toBe(1);
    expect(getRecentEpisodes(getDb(), 'other', 30, now).length).toBe(1);
  });
});

describe('experiment-store: computePosteriors', () => {
  beforeEach(() => {
    runMigrations(getDb(), soulCapability);
  });

  it('reflects only episodes inside EPISODE_DECAY_DAYS', () => {
    const now = new Date('2026-05-20T12:00:00Z');
    // Inside window: 1 success on evening, 1 failure on evening
    insertEpisode({
      timingArm: 'evening',
      outcome: 'replied',
      sentiment: 'positive',
      sentAt: '2026-05-19T18:00:00.000Z',
    });
    insertEpisode({
      timingArm: 'evening',
      outcome: 'ignored',
      sentiment: null,
      sentAt: '2026-05-18T18:00:00.000Z',
    });
    // Outside window: should NOT affect counts
    insertEpisode({
      timingArm: 'evening',
      outcome: 'replied',
      sentiment: 'positive',
      sentAt: '2026-04-01T18:00:00.000Z',
    });

    const post = computePosteriors(getDb(), 'main', now);
    // Evening prior is { alpha: 3, beta: 2 } → +1 success, +1 failure → {4, 3}
    expect(post.evening.alpha).toBe(4);
    expect(post.evening.beta).toBe(3);
    // Untouched arms still equal their priors
    expect(post.morning).toEqual({ alpha: 3, beta: 2 });
    expect(post.afternoon).toEqual({ alpha: 2, beta: 3 });
  });

  it('treats withdrawn episodes as neither success nor failure', () => {
    const now = new Date('2026-05-20T12:00:00Z');
    insertEpisode({
      timingArm: 'morning',
      outcome: 'withdrawn',
      sentiment: null,
      sentAt: '2026-05-19T08:00:00.000Z',
    });
    const post = computePosteriors(getDb(), 'main', now);
    expect(post.morning).toEqual({ alpha: 3, beta: 2 }); // unchanged
  });
});

describe('experiment-store: efficacyRate', () => {
  beforeEach(() => {
    runMigrations(getDb(), soulCapability);
  });

  it('counts replied+positive/neutral as success and excludes withdrawn', () => {
    const now = new Date('2026-05-20T12:00:00Z');
    const day = '2026-05-19T10:00:00.000Z';
    insertEpisode({ outcome: 'replied', sentiment: 'positive', sentAt: day });
    insertEpisode({ outcome: 'replied', sentiment: 'neutral', sentAt: day });
    insertEpisode({ outcome: 'replied', sentiment: 'negative', sentAt: day });
    insertEpisode({ outcome: 'ignored', sentiment: null, sentAt: day });
    insertEpisode({ outcome: 'withdrawn', sentiment: null, sentAt: day });

    // 2 success / (2 success + 2 failure) = 0.5; withdrawn excluded
    expect(efficacyRate(getDb(), 'main', 7, now)).toBe(0.5);
  });

  it('returns null when there are no scored episodes', () => {
    expect(efficacyRate(getDb(), 'main', 7)).toBe(null);
  });
});

describe('experiment-store: readBackoffState clamping', () => {
  beforeEach(() => {
    runMigrations(getDb(), soulCapability);
  });

  it('clamps a 0.0 multiplier up to MIN_OUTREACH_MULTIPLIER', () => {
    insertTuning({
      version: 1,
      stateJson: JSON.stringify({
        targets: { Alice: { outreach_multiplier: 0.0 } },
      }),
      baselineEfficacy: 0.5,
      createdAt: new Date().toISOString(),
    });
    const state = readBackoffState(getDb(), 'main');
    expect(state.targets.Alice.outreach_multiplier).toBe(
      MIN_OUTREACH_MULTIPLIER,
    );
  });

  it('clamps a >1.0 multiplier down to 1.0', () => {
    insertTuning({
      version: 1,
      stateJson: JSON.stringify({
        targets: { Alice: { outreach_multiplier: 1.5 } },
      }),
      baselineEfficacy: 0.5,
      createdAt: new Date().toISOString(),
    });
    expect(
      readBackoffState(getDb(), 'main').targets.Alice.outreach_multiplier,
    ).toBe(1.0);
  });

  it('returns empty targets when no tuning row exists', () => {
    expect(readBackoffState(getDb(), 'main')).toEqual({ targets: {} });
  });

  it('leaves in-range multipliers untouched', () => {
    insertTuning({
      version: 1,
      stateJson: JSON.stringify({
        targets: { Bob: { outreach_multiplier: 0.6 } },
      }),
      baselineEfficacy: 0.5,
      createdAt: new Date().toISOString(),
    });
    expect(
      readBackoffState(getDb(), 'main').targets.Bob.outreach_multiplier,
    ).toBe(0.6);
  });
});

describe('experiment-store: reviewGuardrails', () => {
  beforeEach(() => {
    runMigrations(getDb(), soulCapability);
  });

  it('seeds a baseline row on the first ever review', () => {
    const now = new Date('2026-05-20T12:00:00Z');
    const r = reviewGuardrails(getDb(), 'main', now);
    expect(r.seeded).toBe(true);
    expect(r.skipped).toBe(false);
    expect(r.rolledBack).toBe(false);
    expect(
      getDb()
        .prepare(
          `SELECT COUNT(*) as n FROM experiment_tuning WHERE group_folder = 'main'`,
        )
        .get(),
    ).toEqual({ n: 1 });
  });

  it('is a no-op (skipped) within the rate-limit window', () => {
    const t0 = new Date('2026-05-20T12:00:00Z');
    insertTuning({
      version: 1,
      stateJson: JSON.stringify({ targets: {} }),
      baselineEfficacy: 0.6,
      createdAt: t0.toISOString(),
    });
    // 2 days later — well within the 7-day window
    const t1 = new Date(t0.getTime() + 2 * 86400000);
    const r = reviewGuardrails(getDb(), 'main', t1);
    expect(r.skipped).toBe(true);
    expect(r.rolledBack).toBe(false);
    // Rate-limited skip writes no new row — only the original remains
    expect(
      getDb()
        .prepare(
          `SELECT COUNT(*) as n FROM experiment_tuning WHERE group_folder = 'main'`,
        )
        .get(),
    ).toEqual({ n: 1 });
  });

  it('rolls back to prior state when trailing efficacy regressed', () => {
    const t0 = new Date('2026-05-01T12:00:00Z');
    // Older "good" baseline (version 1, no longer active)
    insertTuning({
      version: 1,
      stateJson: JSON.stringify({
        targets: { Alice: { outreach_multiplier: 1.0 } },
      }),
      baselineEfficacy: 0.5,
      createdAt: new Date(t0.getTime() - 14 * 86400000).toISOString(),
      active: 0,
    });
    // Current active baseline with elevated efficacy
    insertTuning({
      version: 2,
      stateJson: JSON.stringify({
        targets: { Alice: { outreach_multiplier: 0.5 } },
      }),
      baselineEfficacy: 0.8,
      createdAt: t0.toISOString(),
      active: 1,
    });

    // Episodes within 7d of "now" → 1 success, 3 failures → trailing 0.25 < 0.8 baseline
    const now = new Date(t0.getTime() + (ROLLBACK_REVIEW_DAYS + 1) * 86400000);
    insertEpisode({
      outcome: 'replied',
      sentiment: 'positive',
      sentAt: new Date(now.getTime() - 86400000).toISOString(),
    });
    insertEpisode({
      outcome: 'ignored',
      sentiment: null,
      sentAt: new Date(now.getTime() - 86400000).toISOString(),
    });
    insertEpisode({
      outcome: 'ignored',
      sentiment: null,
      sentAt: new Date(now.getTime() - 86400000).toISOString(),
    });
    insertEpisode({
      outcome: 'replied',
      sentiment: 'negative',
      sentAt: new Date(now.getTime() - 86400000).toISOString(),
    });

    const r = reviewGuardrails(getDb(), 'main', now);
    expect(r.rolledBack).toBe(true);
    expect(r.skipped).toBe(false);
    expect(r.driftAlerts.length).toBeGreaterThan(0); // |0.25 - 0.8| ≥ DRIFT_ALERT_DELTA

    // New active row should restore version 1's state_json
    const active = getDb()
      .prepare(
        `SELECT state_json FROM experiment_tuning WHERE group_folder = 'main' AND active = 1`,
      )
      .get() as { state_json: string };
    expect(
      JSON.parse(active.state_json).targets.Alice.outreach_multiplier,
    ).toBe(1.0);
  });

  it('snapshots a healthy baseline (no rollback) when efficacy holds up', () => {
    const t0 = new Date('2026-05-01T12:00:00Z');
    insertTuning({
      version: 1,
      stateJson: JSON.stringify({ targets: {} }),
      baselineEfficacy: 0.4,
      createdAt: t0.toISOString(),
    });
    // 2 successes, 0 failures → 1.0 ≥ 0.4
    const now = new Date(t0.getTime() + (ROLLBACK_REVIEW_DAYS + 1) * 86400000);
    insertEpisode({
      outcome: 'replied',
      sentiment: 'positive',
      sentAt: new Date(now.getTime() - 86400000).toISOString(),
    });
    insertEpisode({
      outcome: 'replied',
      sentiment: 'neutral',
      sentAt: new Date(now.getTime() - 86400000).toISOString(),
    });

    const r = reviewGuardrails(getDb(), 'main', now);
    expect(r.rolledBack).toBe(false);
    expect(r.skipped).toBe(false);
    expect(r.driftAlerts.length).toBeGreaterThan(0); // 1.0 vs 0.4 still crosses DRIFT_ALERT_DELTA
  });

  it('does not roll back on a small efficacy dip within ROLLBACK_REGRESSION_THRESHOLD', () => {
    // The whole point of the threshold: noise-sized dips at this sample
    // size (~3 sends/day) should NOT chain-rollback. Under the pre-threshold
    // strict < comparison this test would have failed.
    const t0 = new Date('2026-05-01T12:00:00Z');
    insertTuning({
      version: 1,
      stateJson: JSON.stringify({
        targets: { Alice: { outreach_multiplier: 1.0 } },
      }),
      baselineEfficacy: 0.6,
      createdAt: new Date(t0.getTime() - 14 * 86400000).toISOString(),
      active: 0,
    });
    insertTuning({
      version: 2,
      stateJson: JSON.stringify({
        targets: { Alice: { outreach_multiplier: 0.5 } },
      }),
      baselineEfficacy: 0.8,
      createdAt: t0.toISOString(),
      active: 1,
    });

    const now = new Date(t0.getTime() + (ROLLBACK_REVIEW_DAYS + 1) * 86400000);
    // 3 success + 1 failure → trailing = 0.75; dip = 0.05, clearly inside
    // the 0.10 threshold.
    const sentAt = new Date(now.getTime() - 86400000).toISOString();
    for (let i = 0; i < 3; i++) {
      insertEpisode({ outcome: 'replied', sentiment: 'positive', sentAt });
    }
    insertEpisode({ outcome: 'ignored', sentiment: null, sentAt });

    const r = reviewGuardrails(getDb(), 'main', now);
    expect(r.rolledBack).toBe(false);
    expect(r.skipped).toBe(false);
    expect(r.trailingEfficacy).toBeCloseTo(0.75);

    // The active state stays at version 2's Alice multiplier (0.5) — it was
    // NOT reverted to version 1's 1.0. (A new healthy-snapshot row gets
    // appended, but it copies the active state_json forward.)
    const active = getDb()
      .prepare(
        `SELECT state_json FROM experiment_tuning WHERE group_folder = 'main' AND active = 1`,
      )
      .get() as { state_json: string };
    expect(
      JSON.parse(active.state_json).targets.Alice.outreach_multiplier,
    ).toBe(0.5);

    // Sanity check that the constant is what we think it is — if anyone
    // raises the threshold past 0.05 this test stops proving anything.
    expect(ROLLBACK_REGRESSION_THRESHOLD).toBeGreaterThanOrEqual(0.05);
  });

  it('rolls back when the efficacy dip clearly exceeds ROLLBACK_REGRESSION_THRESHOLD', () => {
    const t0 = new Date('2026-05-01T12:00:00Z');
    insertTuning({
      version: 1,
      stateJson: JSON.stringify({
        targets: { Alice: { outreach_multiplier: 1.0 } },
      }),
      baselineEfficacy: 0.6,
      createdAt: new Date(t0.getTime() - 14 * 86400000).toISOString(),
      active: 0,
    });
    insertTuning({
      version: 2,
      stateJson: JSON.stringify({
        targets: { Alice: { outreach_multiplier: 0.5 } },
      }),
      baselineEfficacy: 0.8,
      createdAt: t0.toISOString(),
      active: 1,
    });

    const now = new Date(t0.getTime() + (ROLLBACK_REVIEW_DAYS + 1) * 86400000);
    // 6 success + 4 failure → trailing = 0.6; dip = 0.2, comfortably past
    // the 0.10 threshold. This pins the threshold from the other side.
    const sentAt = new Date(now.getTime() - 86400000).toISOString();
    for (let i = 0; i < 6; i++) {
      insertEpisode({ outcome: 'replied', sentiment: 'positive', sentAt });
    }
    for (let i = 0; i < 4; i++) {
      insertEpisode({ outcome: 'ignored', sentiment: null, sentAt });
    }

    const r = reviewGuardrails(getDb(), 'main', now);
    expect(r.rolledBack).toBe(true);
    expect(r.trailingEfficacy).toBeCloseTo(0.6);

    const active = getDb()
      .prepare(
        `SELECT state_json FROM experiment_tuning WHERE group_folder = 'main' AND active = 1`,
      )
      .get() as { state_json: string };
    expect(
      JSON.parse(active.state_json).targets.Alice.outreach_multiplier,
    ).toBe(1.0); // restored from version 1
  });
});

describe('experiment-store: writeExperimentState', () => {
  beforeEach(() => {
    runMigrations(getDb(), soulCapability);
  });

  it('writes valid JSON with all required keys and consistent withdrawal flag', () => {
    const now = new Date('2026-05-20T12:00:00Z');
    writeExperimentState(getDb(), tmpDir, 'main', now, seededRng(1));
    const statePath = path.join(
      tmpDir,
      'main',
      'soul',
      'experiment-state.json',
    );
    expect(fs.existsSync(statePath)).toBe(true);
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));

    expect(state.generated_at).toBe(now.toISOString());
    expect(state.withdrawal_week).toBe(inWithdrawalPeriod(now));
    expect(state.timing).toBeDefined();
    expect(state.timing.posteriors.morning.alpha).toBe(3);
    expect(state.timing.posteriors.morning.beta).toBe(2);
    expect(state.timing.posteriors.morning.n).toBe(0);
    expect(state.timing.posteriors.morning.mean).toBeCloseTo(3 / 5);
    expect(Array.isArray(state.timing.thompson_ranking)).toBe(true);
    expect(state.timing.thompson_ranking.length).toBe(3);
    expect(state.recent_episodes).toEqual([]);
    expect(state.backoff).toEqual({});
    expect(state.efficacy_trailing_7d).toBe(null);
  });

  it('reflects recent episodes and trailing efficacy after data lands', () => {
    const now = new Date('2026-05-20T12:00:00Z');
    insertEpisode({
      target: 'Alice',
      timingArm: 'evening',
      outcome: 'replied',
      sentiment: 'positive',
      sentAt: '2026-05-19T19:00:00.000Z',
    });
    insertEpisode({
      target: 'Alice',
      timingArm: 'evening',
      outcome: 'ignored',
      sentiment: null,
      sentAt: '2026-05-18T19:00:00.000Z',
    });
    writeExperimentState(getDb(), tmpDir, 'main', now, seededRng(2));
    const state = JSON.parse(
      fs.readFileSync(
        path.join(tmpDir, 'main', 'soul', 'experiment-state.json'),
        'utf-8',
      ),
    );
    expect(state.recent_episodes.length).toBe(2);
    expect(state.recent_episodes[0].sent_at).toBe('2026-05-19T19:00:00.000Z'); // newest first
    expect(state.timing.posteriors.evening.n).toBe(2);
    expect(state.efficacy_trailing_7d).toBe(0.5);
  });
});

describe('inWithdrawalPeriod', () => {
  it('is deterministic for a fixed date', () => {
    const d = new Date('2026-05-20T12:00:00Z');
    expect(inWithdrawalPeriod(d)).toBe(inWithdrawalPeriod(d));
  });

  it('returns true for exactly one ISO week in WITHDRAWAL_CYCLE_WEEKS', () => {
    // Walk 8 consecutive ISO weeks. Use Wednesdays to stay safely inside each week.
    const start = new Date('2026-01-07T12:00:00Z'); // Wed of ISO week 2, 2026
    let withdrawalCount = 0;
    for (let i = 0; i < WITHDRAWAL_CYCLE_WEEKS; i++) {
      const d = new Date(start.getTime() + i * 7 * 86400000);
      if (inWithdrawalPeriod(d)) withdrawalCount++;
    }
    expect(withdrawalCount).toBe(1);
  });
});

describe('planning-prompts: Phase 6 bet ledger', () => {
  it('buildMorningPlanPrompt is ledger maintenance, not outreach planning', async () => {
    const { buildMorningPlanPrompt } = await import('./planning-prompts.js');
    const prompt = buildMorningPlanPrompt('main');
    expect(prompt).toContain('bets');
    expect(prompt).toContain('retracted');
    expect(prompt).toContain('NO outreach items');
    // The narrative-planning machinery is gone.
    expect(prompt).not.toContain('experiment-state.json');
    expect(prompt).not.toContain('thompson_ranking');
    expect(prompt).not.toContain('withdrawal_week');
    expect(prompt).not.toContain('check_in');
  });

  it('buildCheckInPrompt resolves and publishes bets', async () => {
    const { buildCheckInPrompt } = await import('./planning-prompts.js');
    const prompt = buildCheckInPrompt('main');
    expect(prompt).toContain('Step 0');
    expect(prompt).toContain("resolution = 'referenced'");
    expect(prompt).toContain('publish_bet');
    expect(prompt).toContain('proactive-budget.json');
    // Old proximal-window evaluation is gone.
    expect(prompt).not.toContain('experiment_episodes');
    expect(prompt).not.toContain('withdrawal_week');
    expect(prompt).not.toContain('timing_arm');
  });

  it('buildProductionPrompt enforces the decision-ready bar and caps', async () => {
    const { buildProductionPrompt } = await import('./planning-prompts.js');
    const { MAX_OPEN_BETS } = await import('./bet-store.js');
    const prompt = buildProductionPrompt('main');
    expect(prompt).toContain('AT MOST ONE bet');
    expect(prompt).toContain('INSERT INTO bets');
    expect(prompt).toContain(String(MAX_OPEN_BETS));
    expect(prompt).toContain('pros/cons');
    // Production never messages the owner directly.
    expect(prompt).toContain('never messages the owner directly');
  });

  // Touch the dormant phase-4.5 constants — the modules stay (demoted, not
  // deleted) and these guard against accidental removal while data exists.
  it('keeps the phase-4.5 tuning constants exported (dormant)', () => {
    expect(DRIFT_ALERT_DELTA).toBeGreaterThan(0);
    expect(EPISODE_DECAY_DAYS).toBeGreaterThan(0);
  });
});

// --- Phase 5 souls migration ---

describe('soulKeyDir (Phase 5)', () => {
  it('returns the legacy base path for the main soul (folder = null)', () => {
    const dir = soulKeyDir('/home/will', null);
    expect(dir).toBe('/home/will/.config/nanoclaw/soul');
  });

  it('returns distinct per-soul subdirs for spawned souls', () => {
    const a = soulKeyDir('/home/will', 'project-rust');
    const b = soulKeyDir('/home/will', 'project-scout');
    expect(a).toBe('/home/will/.config/nanoclaw/soul/project-rust');
    expect(b).toBe('/home/will/.config/nanoclaw/soul/project-scout');
    expect(a).not.toBe(b);
    // Each is under the main keyDir but distinct from it.
    const main = soulKeyDir('/home/will', null);
    expect(a.startsWith(main + '/')).toBe(true);
    expect(a).not.toBe(main);
  });

  it('rejects path-traversal and reserved folder names', () => {
    expect(() => soulKeyDir('/home/will', '..')).toThrow(/Invalid soul folder/);
    expect(() => soulKeyDir('/home/will', '.')).toThrow(/Invalid soul folder/);
    expect(() => soulKeyDir('/home/will', '../escape')).toThrow(
      /Invalid soul folder/,
    );
    expect(() => soulKeyDir('/home/will', 'has spaces')).toThrow(
      /Invalid soul folder/,
    );
    expect(() => soulKeyDir('/home/will', 'has/slash')).toThrow(
      /Invalid soul folder/,
    );
    expect(() => soulKeyDir('/home/will', '')).toThrow(/Invalid soul folder/);
  });

  it('preserves main keypair independence from spawned soul keypairs', () => {
    // Generate a keypair for "main" and a separate one for a spawned soul.
    // The two must be different keys despite sharing a common ancestor dir.
    const homedir = path.join(tmpDir, 'home');
    const mainDir = soulKeyDir(homedir, null);
    const spawnedDir = soulKeyDir(homedir, 'project-rust');
    generateKeypair(mainDir);
    generateKeypair(spawnedDir);
    const main = loadKeypair(mainDir);
    const spawned = loadKeypair(spawnedDir);
    expect(
      Buffer.from(main.publicKeyRaw).equals(Buffer.from(spawned.publicKeyRaw)),
    ).toBe(false);
  });
});

describe('soulsMigration (Phase 5)', () => {
  beforeEach(() => {
    runMigrations(getDb(), soulCapability);
  });

  it('creates the souls table with the expected columns', () => {
    const cols = getDb().prepare(`PRAGMA table_info(souls)`).all() as Array<{
      name: string;
      notnull: number;
      pk: number;
    }>;
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));

    expect(byName.folder?.pk).toBe(1); // PRIMARY KEY
    expect(byName.owner?.notnull).toBe(1);
    expect(byName.agent_name?.notnull).toBe(1);
    expect(byName.state?.notnull).toBe(1);
    expect(byName.spawned_at?.notnull).toBe(1);
    expect(byName.state_changed_at?.notnull).toBe(1);
    expect(byName.did?.notnull).toBe(1);
    // Nullable columns
    expect(byName.channel_jid?.notnull).toBe(0);
    expect(byName.description?.notnull).toBe(0);
    expect(byName.parent_folder?.notnull).toBe(0);
    expect(byName.spawn_reason?.notnull).toBe(0);
  });

  it('creates idx_souls_state', () => {
    const indexes = getDb().prepare(`PRAGMA index_list(souls)`).all() as Array<{
      name: string;
    }>;
    expect(indexes.some((i) => i.name === 'idx_souls_state')).toBe(true);
  });

  it('accepts a row and partitions by state', () => {
    const stmt = getDb().prepare(
      `INSERT INTO souls (folder, owner, agent_name, state,
                          spawned_at, state_changed_at, did, parent_folder, spawn_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = '2026-05-27T00:00:00Z';
    stmt.run(
      'project-rust',
      'will',
      'Rust Soul',
      'active',
      now,
      now,
      'did:wba:host:agent:project-rust',
      'main',
      'learning rust',
    );
    stmt.run(
      'project-old',
      'will',
      'Old Soul',
      'archived',
      now,
      now,
      'did:wba:host:agent:project-old',
      'main',
      'wrapped up',
    );

    const active = getDb()
      .prepare(`SELECT folder FROM souls WHERE state = 'active'`)
      .all() as Array<{ folder: string }>;
    expect(active).toEqual([{ folder: 'project-rust' }]);
  });

  it('rejects duplicate folder names (PRIMARY KEY)', () => {
    const stmt = getDb().prepare(
      `INSERT INTO souls (folder, owner, agent_name, state,
                          spawned_at, state_changed_at, did)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = '2026-05-27T00:00:00Z';
    stmt.run(
      'proj-x',
      'will',
      'X',
      'active',
      now,
      now,
      'did:wba:host:agent:proj-x',
    );
    expect(() =>
      stmt.run(
        'proj-x',
        'will',
        'X again',
        'active',
        now,
        now,
        'did:wba:host:agent:proj-x',
      ),
    ).toThrow();
  });

  it('round-trips cleanly via down() then up()', () => {
    rollbackCapability(getDb(), soulCapability);
    const dropped = getDb()
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='souls'`,
      )
      .all() as Array<{ name: string }>;
    expect(dropped.length).toBe(0);
    runMigrations(getDb(), soulCapability);
    const recreated = getDb()
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='souls'`,
      )
      .all() as Array<{ name: string }>;
    expect(recreated.length).toBe(1);
  });
});

// --- Phase 5 protocol: canonical + envelope + signing ---

describe('canonicalize (shared with identity.ts)', () => {
  it('sorts object keys recursively', () => {
    const a = canonicalize({ b: 1, a: { y: 2, x: 1 } });
    const b = canonicalize({ a: { x: 1, y: 2 }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"x":1,"y":2},"b":1}');
  });

  it('preserves array order', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });

  it('handles primitives and null', () => {
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize(42)).toBe('42');
    expect(canonicalize('hi')).toBe('"hi"');
    expect(canonicalize(true)).toBe('true');
  });
});

describe('buildEnvelope', () => {
  it('fills required fields and generates a UUID id by default', () => {
    const env = buildEnvelope({
      from: 'did:wba:host:agent:main',
      to: 'did:wba:host:agent:rust',
      verb: 'query_state',
      body: { what: 'plan' },
      now: new Date('2026-05-28T12:00:00Z'),
    });
    expect(env.from).toBe('did:wba:host:agent:main');
    expect(env.to).toBe('did:wba:host:agent:rust');
    expect(env.verb).toBe('query_state');
    expect(env.body).toEqual({ what: 'plan' });
    expect(env.ts).toBe('2026-05-28T12:00:00.000Z');
    expect(env.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('honours an explicit id override (for test determinism)', () => {
    const env = buildEnvelope({
      from: 'a',
      to: 'b',
      verb: 'get_agent_card',
      body: null,
      id: 'pinned-id-1',
    });
    expect(env.id).toBe('pinned-id-1');
  });

  it('canonicalEnvelopeBytes is insertion-order independent', () => {
    const env1 = buildEnvelope({
      from: 'a',
      to: 'b',
      verb: 'query_wiki',
      body: { page: 'people', other: 'x' },
      id: 'x',
      now: new Date('2026-05-28T00:00:00Z'),
    });
    // Same structural content, JSON.parse-trip rebuilds keys in arbitrary order
    const reparsed = JSON.parse(JSON.stringify(env1));
    expect(
      canonicalEnvelopeBytes(env1).equals(canonicalEnvelopeBytes(reparsed)),
    ).toBe(true);
  });
});

describe('signMessage + verifyMessage', () => {
  let mainPriv: crypto.KeyObject;
  let mainPub: crypto.KeyObject;
  let attackerPriv: crypto.KeyObject;
  let attackerPub: crypto.KeyObject;

  beforeEach(() => {
    _resetReplayCacheForTests();
    const mainKp = crypto.generateKeyPairSync('ed25519');
    mainPriv = mainKp.privateKey;
    mainPub = mainKp.publicKey;
    const attackerKp = crypto.generateKeyPairSync('ed25519');
    attackerPriv = attackerKp.privateKey;
    attackerPub = attackerKp.publicKey;
  });

  function makeEnvelope(overrides: Partial<{ id: string; to: string }> = {}) {
    return buildEnvelope({
      from: 'did:wba:host:agent:main',
      to: overrides.to ?? 'did:wba:host:agent:rust',
      verb: 'get_agent_card',
      body: {},
      id: overrides.id ?? 'pinned-id-' + Math.random(),
      now: new Date('2026-05-28T12:00:00Z'),
    });
  }

  it('verifies a correctly signed message', () => {
    const env = makeEnvelope();
    const signed = signMessage(env, mainPriv, 'did:wba:host:agent:main#key-1');
    const res = verifyMessage(signed, {
      resolvePublicKey: () => mainPub,
      expectedTo: env.to,
    });
    expect(res.ok).toBe(true);
  });

  it('rejects when the envelope was mutated after signing', () => {
    const env = makeEnvelope();
    const signed = signMessage(env, mainPriv, 'did:wba:host:agent:main#key-1');
    const tampered: SignedMessage = {
      ...signed,
      envelope: { ...signed.envelope, verb: 'query_wiki' },
    };
    const res = verifyMessage(tampered, {
      resolvePublicKey: () => mainPub,
      expectedTo: env.to,
    });
    expect(res).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it('rejects when the signature was made with a different key', () => {
    const env = makeEnvelope();
    const signed = signMessage(
      env,
      attackerPriv,
      'did:wba:host:agent:main#key-1',
    );
    const res = verifyMessage(signed, {
      resolvePublicKey: () => mainPub, // claims to be main, but actually attacker signed
      expectedTo: env.to,
    });
    expect(res).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it('rejects when the keyId resolves to no public key', () => {
    const env = makeEnvelope();
    const signed = signMessage(env, mainPriv, 'did:wba:host:agent:ghost#key-1');
    const res = verifyMessage(signed, {
      resolvePublicKey: () => null,
      expectedTo: env.to,
    });
    expect(res).toEqual({ ok: false, reason: 'unknown_key' });
  });

  it('rejects when envelope.to does not match expectedTo', () => {
    const env = makeEnvelope({ to: 'did:wba:host:agent:elsewhere' });
    const signed = signMessage(env, mainPriv, 'did:wba:host:agent:main#key-1');
    const res = verifyMessage(signed, {
      resolvePublicKey: () => mainPub,
      expectedTo: 'did:wba:host:agent:rust',
    });
    expect(res).toEqual({ ok: false, reason: 'envelope_to_mismatch' });
  });

  it('rejects a replay within REPLAY_TTL_SEC', () => {
    const env = makeEnvelope({ id: 'replay-test-id' });
    const signed = signMessage(env, mainPriv, 'did:wba:host:agent:main#key-1');
    const t0 = new Date('2026-05-28T12:00:00Z');

    const first = verifyMessage(signed, {
      resolvePublicKey: () => mainPub,
      expectedTo: env.to,
      now: t0,
    });
    expect(first).toEqual({ ok: true });

    const replay = verifyMessage(signed, {
      resolvePublicKey: () => mainPub,
      expectedTo: env.to,
      now: new Date(t0.getTime() + 30 * 1000), // 30s later, still inside TTL
    });
    expect(replay).toEqual({ ok: false, reason: 'replay' });
  });

  it('forgets stale nonces after REPLAY_TTL_SEC so the cache cannot grow forever', () => {
    const env = makeEnvelope({ id: 'old-id' });
    const signed = signMessage(env, mainPriv, 'did:wba:host:agent:main#key-1');
    const t0 = new Date('2026-05-28T12:00:00Z');

    verifyMessage(signed, {
      resolvePublicKey: () => mainPub,
      expectedTo: env.to,
      now: t0,
    });

    // A *different* later message triggers the sweep, freeing old-id's slot.
    const later = buildEnvelope({
      from: env.from,
      to: env.to,
      verb: env.verb,
      body: env.body,
      id: 'sweeper',
      now: new Date(t0.getTime() + (REPLAY_TTL_SEC + 5) * 1000),
    });
    const laterSigned = signMessage(
      later,
      mainPriv,
      'did:wba:host:agent:main#key-1',
    );
    verifyMessage(laterSigned, {
      resolvePublicKey: () => mainPub,
      expectedTo: env.to,
      now: new Date(t0.getTime() + (REPLAY_TTL_SEC + 5) * 1000),
    });

    // old-id should now be evictable — replaying it works again.
    const replayOk = verifyMessage(signed, {
      resolvePublicKey: () => mainPub,
      expectedTo: env.to,
      now: new Date(t0.getTime() + (REPLAY_TTL_SEC + 10) * 1000),
    });
    expect(replayOk).toEqual({ ok: true });
  });

  it('rejects a structurally malformed SignedMessage', () => {
    const broken = { envelope: { id: 'x' } } as unknown as SignedMessage;
    const res = verifyMessage(broken, {
      resolvePublicKey: () => mainPub,
      expectedTo: 'whatever',
    });
    expect(res).toEqual({ ok: false, reason: 'malformed' });
  });

  // Touch the constants/imports so unused-import lint doesn't pull them.
  it('exports REPLAY_TTL_SEC at a sensible value', () => {
    expect(REPLAY_TTL_SEC).toBeGreaterThanOrEqual(30);
    expect(REPLAY_TTL_SEC).toBeLessThanOrEqual(600);
    // Touch attackerPub to keep TS happy about an unused beforeEach assignment
    expect(attackerPub).toBeDefined();
  });
});

// --- Phase 5 verb body guards (types.ts) ---

describe('verb request guards', () => {
  describe('isGetAgentCardRequest', () => {
    it('accepts the empty object', () => {
      expect(isGetAgentCardRequest({})).toBe(true);
    });

    it('accepts unknown extra keys (forward-compat)', () => {
      expect(isGetAgentCardRequest({ version: 'v2' })).toBe(true);
    });

    it('rejects non-objects', () => {
      expect(isGetAgentCardRequest(null)).toBe(false);
      expect(isGetAgentCardRequest(undefined)).toBe(false);
      expect(isGetAgentCardRequest('hi')).toBe(false);
      expect(isGetAgentCardRequest([1, 2])).toBe(false);
    });
  });

  describe('isQueryWikiRequest', () => {
    it('accepts a request with a non-empty page name', () => {
      expect(isQueryWikiRequest({ page: 'people' })).toBe(true);
    });

    it('rejects missing or empty page', () => {
      expect(isQueryWikiRequest({})).toBe(false);
      expect(isQueryWikiRequest({ page: '' })).toBe(false);
      expect(isQueryWikiRequest({ page: 123 })).toBe(false);
      expect(isQueryWikiRequest(null)).toBe(false);
    });
  });

  describe('isProposeInterventionRequest', () => {
    it('accepts the minimum required shape', () => {
      expect(
        isProposeInterventionRequest({
          intervention_type: 'approval_needed',
          question: 'Should I send this?',
        }),
      ).toBe(true);
    });

    it('accepts all optional fields when correctly typed', () => {
      expect(
        isProposeInterventionRequest({
          intervention_type: 'approval_needed',
          question: 'q?',
          context: 'because X',
          options: ['yes', 'no'],
          priority: 'high',
          metadata: { source_soul: 'project-rust' },
        }),
      ).toBe(true);
    });

    it('rejects missing intervention_type or question', () => {
      expect(isProposeInterventionRequest({ question: 'no type field' })).toBe(
        false,
      );
      expect(isProposeInterventionRequest({ intervention_type: 'x' })).toBe(
        false,
      );
      expect(
        isProposeInterventionRequest({
          intervention_type: '',
          question: 'empty type',
        }),
      ).toBe(false);
    });

    it('rejects malformed optional fields', () => {
      expect(
        isProposeInterventionRequest({
          intervention_type: 'x',
          question: 'q',
          options: 'should be an array',
        }),
      ).toBe(false);
      expect(
        isProposeInterventionRequest({
          intervention_type: 'x',
          question: 'q',
          options: ['ok', 42], // mixed types
        }),
      ).toBe(false);
      expect(
        isProposeInterventionRequest({
          intervention_type: 'x',
          question: 'q',
          priority: 'urgent', // not in the union
        }),
      ).toBe(false);
      expect(
        isProposeInterventionRequest({
          intervention_type: 'x',
          question: 'q',
          metadata: ['not', 'an', 'object'],
        }),
      ).toBe(false);
    });
  });

  describe('isQueryStateRequest', () => {
    it('accepts each declared slice', () => {
      for (const slice of ['plan_summary', 'recent_episodes', 'backoff']) {
        expect(isQueryStateRequest({ slice })).toBe(true);
      }
    });

    it('rejects an unknown slice or missing field', () => {
      expect(isQueryStateRequest({ slice: 'wiki' })).toBe(false);
      expect(isQueryStateRequest({})).toBe(false);
      expect(isQueryStateRequest({ slice: null })).toBe(false);
      expect(isQueryStateRequest('plan_summary')).toBe(false);
    });
  });
});

// --- Phase 5 LoopbackTransport ---

describe('LoopbackTransport', () => {
  // Reusable fake signed message — the transport never inspects body or
  // signature, it only routes by targetDid.
  function fakeSigned(toDid: string, payload: unknown = null): SignedMessage {
    return {
      envelope: {
        id: 'env-' + Math.random().toString(36).slice(2),
        from: 'did:wba:host:agent:main',
        to: toDid,
        verb: 'get_agent_card',
        ts: '2026-05-29T00:00:00.000Z',
        body: payload,
      },
      signature: { alg: 'Ed25519', keyId: 'k1', proof: 'aGk' },
    };
  }

  it('routes send() to the matching registered handler and returns its response', async () => {
    const t = new LoopbackTransport();
    t.registerSoul('did:wba:host:agent:rust', async (req) => ({
      ...req,
      envelope: { ...req.envelope, body: { echoed: req.envelope.body } },
    }));
    const req = fakeSigned('did:wba:host:agent:rust', { hello: 'rust' });
    const res = await t.send('did:wba:host:agent:rust', req);
    expect((res.envelope.body as { echoed: unknown }).echoed).toEqual({
      hello: 'rust',
    });
  });

  it('throws when sending to an unregistered DID', async () => {
    const t = new LoopbackTransport();
    await expect(
      t.send('did:wba:host:agent:ghost', fakeSigned('x')),
    ).rejects.toThrow(/no handler/);
  });

  it('unregisterSoul removes the handler', async () => {
    const t = new LoopbackTransport();
    t.registerSoul('did:wba:host:agent:rust', async (req) => req);
    expect(t.registeredCount()).toBe(1);
    t.unregisterSoul('did:wba:host:agent:rust');
    expect(t.registeredCount()).toBe(0);
    await expect(
      t.send('did:wba:host:agent:rust', fakeSigned('did:wba:host:agent:rust')),
    ).rejects.toThrow(/no handler/);
  });

  it('rejects duplicate DID registration loudly (caught at spawn, not silent overwrite)', () => {
    const t = new LoopbackTransport();
    t.registerSoul('did:wba:host:agent:rust', async (req) => req);
    expect(() =>
      t.registerSoul('did:wba:host:agent:rust', async (req) => req),
    ).toThrow(/already registered/);
  });

  it('keeps concurrent sends isolated per target', async () => {
    const t = new LoopbackTransport();
    // Two handlers tag the response with their own DID so we can verify
    // routing wasn't cross-wired by some shared mutable state.
    t.registerSoul('did:wba:host:agent:a', async (req) => ({
      ...req,
      envelope: { ...req.envelope, body: { from_handler: 'A' } },
    }));
    t.registerSoul('did:wba:host:agent:b', async (req) => {
      // Tiny delay so the two promises interleave.
      await new Promise((r) => setTimeout(r, 5));
      return {
        ...req,
        envelope: { ...req.envelope, body: { from_handler: 'B' } },
      };
    });

    const [rA, rB] = await Promise.all([
      t.send('did:wba:host:agent:a', fakeSigned('did:wba:host:agent:a')),
      t.send('did:wba:host:agent:b', fakeSigned('did:wba:host:agent:b')),
    ]);
    expect((rA.envelope.body as { from_handler: string }).from_handler).toBe(
      'A',
    );
    expect((rB.envelope.body as { from_handler: string }).from_handler).toBe(
      'B',
    );
  });

  it('onRequest throws — loopback uses registerSoul instead', () => {
    const t = new LoopbackTransport();
    expect(() => t.onRequest(async (req) => req)).toThrow(/registerSoul/);
  });
});

// --- Phase 5 protocol handler (the four verbs) ---

describe('folderFromDid', () => {
  it('parses the folder slug out of a well-formed DID', () => {
    expect(folderFromDid('did:wba:host:agent:project-rust')).toBe(
      'project-rust',
    );
    expect(folderFromDid('did:wba:other:agent:main')).toBe('main');
  });

  it('returns null when the suffix does not match', () => {
    expect(folderFromDid('did:wba:host:nonsense')).toBe(null);
    expect(folderFromDid('not-a-did')).toBe(null);
    expect(folderFromDid('did:wba:host:agent:has spaces')).toBe(null);
  });
});

describe('handleRequest (protocol verbs)', () => {
  let mainKp: { privateKey: crypto.KeyObject; publicKey: crypto.KeyObject };
  let receiverDid: string;
  let receiverFolder: string;
  let receiverCtx: SoulContext;

  beforeEach(() => {
    _resetReplayCacheForTests();
    runMigrations(getDb(), soulCapability);
    mainKp = crypto.generateKeyPairSync('ed25519');
    receiverDid = 'did:wba:host:agent:main';
    receiverFolder = 'main';
    fs.mkdirSync(path.join(tmpDir, receiverFolder, 'soul', 'wiki'), {
      recursive: true,
    });
    receiverCtx = {
      did: receiverDid,
      keyId: `${receiverDid}#key-1`,
      privateKey: mainKp.privateKey,
      folder: receiverFolder,
      agentName: 'Andy',
      groupsDir: tmpDir,
      db: getDb(),
    };
  });

  // Build a request signed by the caller. The handler doesn't verify
  // (that's the transport's job before dispatch) but we still sign so the
  // response's `to` field round-trips correctly.
  function buildRequest(
    callerDid: string,
    callerKp: { privateKey: crypto.KeyObject },
    verb: import('./protocol/types.js').Verb,
    body: unknown,
  ): SignedMessage {
    const env = buildEnvelope({
      from: callerDid,
      to: receiverDid,
      verb,
      body,
      now: new Date('2026-05-29T12:00:00Z'),
    });
    return signMessage(env, callerKp.privateKey, `${callerDid}#key-1`);
  }

  it('REQUIRED_TIER covers every verb', () => {
    expect(REQUIRED_TIER.get_agent_card).toBeDefined();
    expect(REQUIRED_TIER.query_wiki).toBeDefined();
    expect(REQUIRED_TIER.propose_intervention).toBeDefined();
    expect(REQUIRED_TIER.query_state).toBeDefined();
  });

  it('LOOPBACK_DEFAULT_TIER is `trusted` per spec §17', () => {
    expect(LOOPBACK_DEFAULT_TIER).toBe('trusted');
  });

  it('get_agent_card returns a placeholder card when no provider is wired', async () => {
    const callerKp = crypto.generateKeyPairSync('ed25519');
    const req = buildRequest(
      'did:wba:host:agent:rust',
      callerKp,
      'get_agent_card',
      {},
    );
    const res = await handleRequest(req, 'public', receiverCtx);
    const body = res.envelope.body as {
      card: { did: string; agentName: string; placeholder: boolean };
    };
    expect(body.card.did).toBe(receiverDid);
    expect(body.card.agentName).toBe('Andy');
    expect(body.card.placeholder).toBe(true);
    // Response is from receiver, addressed back to caller.
    expect(res.envelope.from).toBe(receiverDid);
    expect(res.envelope.to).toBe('did:wba:host:agent:rust');
    expect(res.signature.keyId).toBe(`${receiverDid}#key-1`);
  });

  it('get_agent_card delegates to a provider when present', async () => {
    receiverCtx.getAgentCard = () => ({ custom: 'card-from-step-7' });
    const callerKp = crypto.generateKeyPairSync('ed25519');
    const req = buildRequest(
      'did:wba:host:agent:rust',
      callerKp,
      'get_agent_card',
      {},
    );
    const res = await handleRequest(req, 'public', receiverCtx);
    expect(res.envelope.body).toEqual({ card: { custom: 'card-from-step-7' } });
  });

  it('query_wiki reads a valid page', async () => {
    fs.writeFileSync(
      path.join(tmpDir, receiverFolder, 'soul', 'wiki', 'people.md'),
      '# People\n\nAlice prefers brevity.\n',
      'utf-8',
    );
    const callerKp = crypto.generateKeyPairSync('ed25519');
    const req = buildRequest(
      'did:wba:host:agent:rust',
      callerKp,
      'query_wiki',
      { page: 'people' },
    );
    const res = await handleRequest(req, 'trusted', receiverCtx);
    const body = res.envelope.body as {
      content: string;
      lastModifiedMs: number | null;
    };
    expect(body.content).toContain('Alice prefers brevity');
    expect(typeof body.lastModifiedMs).toBe('number');
  });

  it('query_wiki returns empty for an unknown page (not_found semantics)', async () => {
    const callerKp = crypto.generateKeyPairSync('ed25519');
    const req = buildRequest(
      'did:wba:host:agent:rust',
      callerKp,
      'query_wiki',
      { page: 'absent' },
    );
    const res = await handleRequest(req, 'trusted', receiverCtx);
    expect(res.envelope.body).toEqual({ content: '', lastModifiedMs: null });
  });

  it('query_wiki refuses path-traversal and absolute paths via the slug validator', async () => {
    const callerKp = crypto.generateKeyPairSync('ed25519');
    for (const bad of [
      '../escape',
      '/etc/passwd',
      'has/slash',
      'with.dots',
      '',
    ]) {
      const req = buildRequest(
        'did:wba:host:agent:rust',
        callerKp,
        'query_wiki',
        { page: bad },
      );
      const res = await handleRequest(req, 'trusted', receiverCtx);
      const body = res.envelope.body as { error?: { code: string } };
      expect(body.error?.code).toBe('bad_request');
    }
  });

  it('propose_intervention inserts a properly-tagged row into memory_stream', async () => {
    const callerKp = crypto.generateKeyPairSync('ed25519');
    const req = buildRequest(
      'did:wba:host:agent:project-rust',
      callerKp,
      'propose_intervention',
      {
        intervention_type: 'spawn_followup',
        question: 'Will committed to 3h/week and missed last week. Surface?',
        context: 'detected in project-rust memory_stream',
        priority: 'medium',
      },
    );
    const res = await handleRequest(req, 'trusted', receiverCtx);
    const body = res.envelope.body as {
      accepted: boolean;
      interventionId: string;
    };
    expect(body.accepted).toBe(true);
    expect(body.interventionId).toMatch(/^[0-9a-f-]{36}$/);

    const rows = getUncurated(getDb(), receiverFolder);
    const inserted = rows.find((r) => r.id === body.interventionId);
    expect(inserted).toBeDefined();
    expect(inserted!.type).toBe('intervention');
    expect(inserted!.source).toBe('spawned-soul');
    const metadata = JSON.parse(inserted!.metadata!);
    expect(metadata.intervention_type).toBe('spawn_followup');
    expect(metadata.status).toBe('pending');
    expect(metadata.origin_folder).toBe('project-rust');
    expect(metadata.origin_did).toBe('did:wba:host:agent:project-rust');
  });

  it('propose_intervention rejects a malformed payload as bad_request', async () => {
    const callerKp = crypto.generateKeyPairSync('ed25519');
    const req = buildRequest(
      'did:wba:host:agent:rust',
      callerKp,
      'propose_intervention',
      { intervention_type: 'x' }, // missing question
    );
    const res = await handleRequest(req, 'trusted', receiverCtx);
    expect((res.envelope.body as { error: { code: string } }).error.code).toBe(
      'bad_request',
    );
  });

  it('query_state returns plan_summary even when no plan file exists', async () => {
    const callerKp = crypto.generateKeyPairSync('ed25519');
    const req = buildRequest(
      'did:wba:host:agent:rust',
      callerKp,
      'query_state',
      { slice: 'plan_summary' },
    );
    const res = await handleRequest(req, 'trusted', receiverCtx);
    expect(res.envelope.body).toEqual({
      slice: 'plan_summary',
      date: null,
      itemCount: 0,
      notes: null,
    });
  });

  it('query_state plan_summary reads an existing plan and returns count + notes', async () => {
    fs.writeFileSync(
      path.join(tmpDir, receiverFolder, 'soul', 'daily-plan.json'),
      JSON.stringify({
        date: '2026-05-29',
        items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
        notes: 'busy day',
      }),
      'utf-8',
    );
    const callerKp = crypto.generateKeyPairSync('ed25519');
    const req = buildRequest(
      'did:wba:host:agent:rust',
      callerKp,
      'query_state',
      { slice: 'plan_summary' },
    );
    const res = await handleRequest(req, 'trusted', receiverCtx);
    expect(res.envelope.body).toEqual({
      slice: 'plan_summary',
      date: '2026-05-29',
      itemCount: 3,
      notes: 'busy day',
    });
  });

  it('query_state recent_episodes returns sanitized episode rows', async () => {
    getDb()
      .prepare(
        `INSERT INTO experiment_episodes
           (id, group_folder, plan_item_id, target, timing_arm, sent_at,
            message_excerpt, outcome, sentiment, proximal_window_min, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        receiverFolder,
        null,
        'Alice',
        'evening',
        new Date(Date.now() - 86_400_000).toISOString(),
        'hi',
        'replied',
        'positive',
        90,
        new Date().toISOString(),
      );
    const callerKp = crypto.generateKeyPairSync('ed25519');
    const req = buildRequest(
      'did:wba:host:agent:rust',
      callerKp,
      'query_state',
      { slice: 'recent_episodes' },
    );
    const res = await handleRequest(req, 'trusted', receiverCtx);
    const body = res.envelope.body as {
      slice: 'recent_episodes';
      episodes: Array<Record<string, unknown>>;
    };
    expect(body.slice).toBe('recent_episodes');
    expect(body.episodes.length).toBe(1);
    // Only the contract fields are exposed.
    expect(Object.keys(body.episodes[0]).sort()).toEqual(
      ['outcome', 'sent_at', 'sentiment', 'target', 'timing_arm'].sort(),
    );
  });

  it('query_state backoff strips internal fields like `since`', async () => {
    getDb()
      .prepare(
        `INSERT INTO experiment_tuning
           (id, group_folder, version, state_json, baseline_efficacy, created_at, active)
         VALUES (?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(
        crypto.randomUUID(),
        receiverFolder,
        1,
        JSON.stringify({
          targets: {
            Alice: { outreach_multiplier: 0.5, since: '2026-04-01T00:00:00Z' },
          },
        }),
        0.5,
        new Date().toISOString(),
      );
    const callerKp = crypto.generateKeyPairSync('ed25519');
    const req = buildRequest(
      'did:wba:host:agent:rust',
      callerKp,
      'query_state',
      { slice: 'backoff' },
    );
    const res = await handleRequest(req, 'trusted', receiverCtx);
    const body = res.envelope.body as {
      slice: 'backoff';
      targets: Record<string, Record<string, unknown>>;
    };
    expect(body.targets.Alice).toEqual({ outreach_multiplier: 0.5 });
    // `since` must not be in the public response.
    expect('since' in body.targets.Alice).toBe(false);
  });

  it('returns forbidden when caller tier is below the verb requirement (403-style)', async () => {
    const callerKp = crypto.generateKeyPairSync('ed25519');
    const req = buildRequest(
      'did:wba:host:agent:rust',
      callerKp,
      'query_state',
      { slice: 'plan_summary' },
    );
    // 'public' is below the 'trusted' requirement for query_state.
    const res = await handleRequest(req, 'public', receiverCtx);
    const body = res.envelope.body as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe('forbidden');
    expect(body.error.message).toContain('trusted');
  });

  it('response envelope is signed by the receiver and addressed back to the caller', async () => {
    const callerKp = crypto.generateKeyPairSync('ed25519');
    const callerDid = 'did:wba:host:agent:rust';
    const req = buildRequest(
      callerKp ? callerDid : '',
      callerKp,
      'get_agent_card',
      {},
    );
    const res = await handleRequest(req, 'public', receiverCtx);

    // Verify the response signature using the receiver's public key.
    const verifyRes = verifyMessage(res, {
      resolvePublicKey: () => mainKp.publicKey,
      expectedTo: callerDid,
    });
    expect(verifyRes).toEqual({ ok: true });
  });
});

// --- Phase 5 agent-card (v1.2 signed AgentCard) ---

describe('discoverCapabilities tier assignment (Phase 5 addition)', () => {
  it('tags shell-execution as inner_circle and the rest as trusted', () => {
    const caps = discoverCapabilities({
      channelNames: ['whatsapp'],
      skillNames: ['add-soul'],
      hasScheduler: true,
    });
    const byName = Object.fromEntries(caps.map((c) => [c.name, c]));
    expect(byName['shell-execution'].tier).toBe('inner_circle');
    expect(byName['web-browsing'].tier).toBe('trusted');
    expect(byName['file-management'].tier).toBe('trusted');
    expect(byName['whatsapp-messaging'].tier).toBe('trusted');
    expect(byName['scheduling'].tier).toBe('trusted');
    expect(byName['skill:add-soul'].tier).toBe('trusted');
  });

  it('generateAgentDescription propagates tier as anp:tier on each capability', () => {
    const desc = generateAgentDescription({
      domain: 'host',
      agentName: 'Andy',
      owner: 'Will',
      channelNames: [],
      skillNames: [],
      hasScheduler: false,
    }) as { 'anp:capabilities': Array<{ name: string; 'anp:tier': string }> };
    for (const c of desc['anp:capabilities']) {
      expect(typeof c['anp:tier']).toBe('string');
    }
    const shell = desc['anp:capabilities'].find(
      (c) => c.name === 'shell-execution',
    );
    expect(shell?.['anp:tier']).toBe('inner_circle');
  });
});

describe('buildAgentCard / buildSignedAgentCard', () => {
  let kp: { privateKey: crypto.KeyObject; publicKey: crypto.KeyObject };
  let publicKeyRaw: Uint8Array;

  beforeEach(() => {
    const keyDir = path.join(tmpDir, 'agent-card-keys');
    generateKeypair(keyDir);
    const loaded = loadKeypair(keyDir);
    kp = { privateKey: loaded.privateKey, publicKey: loaded.publicKey };
    publicKeyRaw = loaded.publicKeyRaw;
  });

  it('builds an unsigned card with the expected v1.2 shape', () => {
    const card = buildAgentCard({
      did: 'did:wba:host:agent:main',
      agentName: 'Andy',
      owner: 'Will',
      capabilities: [
        { name: 'web-browsing', description: 'browse', tier: 'trusted' },
      ],
      publicKeyRaw,
      verificationMethodId: 'did:wba:host:agent:main#key-1',
      now: new Date('2026-05-29T00:00:00Z'),
    });
    expect(card.schemaVersion).toBe(AGENT_CARD_SCHEMA_VERSION);
    expect(card.did).toBe('did:wba:host:agent:main');
    expect(card.name).toBe('Andy');
    expect(card.owner).toBe('Will');
    expect(card.endpoints).toEqual({ a2a: 'loopback' });
    expect((card.publicKey as { keyId: string }).keyId).toBe(
      'did:wba:host:agent:main#key-1',
    );
    expect(
      (card.publicKey as { publicKeyMultibase: string }).publicKeyMultibase,
    ).toMatch(/^z6Mk/);
    expect(card.createdAt).toBe('2026-05-29T00:00:00.000Z');
    // Description defaults from owner when omitted.
    expect((card.description as string).includes('Will')).toBe(true);
  });

  it('honours an explicit endpoint, description, and traits', () => {
    const card = buildAgentCard({
      did: 'did:wba:host:agent:main',
      agentName: 'Andy',
      owner: 'Will',
      description: 'custom desc',
      traits: ['warm', 'terse'],
      capabilities: [],
      publicKeyRaw,
      verificationMethodId: 'did:wba:host:agent:main#key-1',
      endpoint: 'https://host.tail.example/a2a',
    });
    expect(card.description).toBe('custom desc');
    expect(card.traits).toEqual(['warm', 'terse']);
    expect(card.endpoints).toEqual({ a2a: 'https://host.tail.example/a2a' });
  });

  it('omits traits when none provided (no empty array key in the signed payload)', () => {
    const card = buildAgentCard({
      did: 'did:wba:host:agent:main',
      agentName: 'Andy',
      owner: 'Will',
      capabilities: [],
      publicKeyRaw,
      verificationMethodId: 'did:wba:host:agent:main#key-1',
    });
    expect('traits' in card).toBe(false);
  });

  it('signed card has a verifiable Ed25519 proof (re-canonicalize + verify)', () => {
    const signed = buildSignedAgentCard(
      {
        did: 'did:wba:host:agent:main',
        agentName: 'Andy',
        owner: 'Will',
        capabilities: [
          { name: 'web-browsing', description: 'browse', tier: 'trusted' },
        ],
        publicKeyRaw,
        verificationMethodId: 'did:wba:host:agent:main#key-1',
        now: new Date('2026-05-29T00:00:00Z'),
      },
      kp.privateKey,
    );

    // Strip the signature and re-canonicalize, then verify the proof bytes
    // against the receiver's public key — the same path a peer soul would
    // take to validate an inbound AgentCard.
    const { 'anp:signature': sig, ...unsigned } = signed as Record<
      string,
      unknown
    >;
    const sigObj = sig as { proofValue: string; verificationMethod: string };
    expect(sigObj.verificationMethod).toBe('did:wba:host:agent:main#key-1');

    const proof = Buffer.from(sigObj.proofValue, 'base64url');
    const canonical = canonicalize(unsigned);
    const ok = crypto.verify(
      null,
      Buffer.from(canonical, 'utf-8'),
      kp.publicKey,
      proof,
    );
    expect(ok).toBe(true);
  });

  it('signed card from one soul does NOT verify against a different soul key', () => {
    const otherKp = crypto.generateKeyPairSync('ed25519');
    const signed = buildSignedAgentCard(
      {
        did: 'did:wba:host:agent:main',
        agentName: 'Andy',
        owner: 'Will',
        capabilities: [],
        publicKeyRaw,
        verificationMethodId: 'did:wba:host:agent:main#key-1',
      },
      kp.privateKey,
    );
    const { 'anp:signature': sig, ...unsigned } = signed as Record<
      string,
      unknown
    >;
    const sigObj = sig as { proofValue: string };
    const proof = Buffer.from(sigObj.proofValue, 'base64url');
    const canonical = canonicalize(unsigned);
    const ok = crypto.verify(
      null,
      Buffer.from(canonical, 'utf-8'),
      otherKp.publicKey,
      proof,
    );
    expect(ok).toBe(false);
  });
});

describe('capabilitiesForCard adapter', () => {
  it('strips DiscoveredCapability down to the AgentCard contract', () => {
    const discovered = discoverCapabilities({
      channelNames: ['whatsapp'],
      skillNames: [],
      hasScheduler: false,
    });
    const cardCaps = capabilitiesForCard(discovered);
    expect(cardCaps.length).toBe(discovered.length);
    for (const c of cardCaps) {
      expect(Object.keys(c).sort()).toEqual(
        ['description', 'name', 'tier'].sort(),
      );
    }
  });
});

describe('handleRequest get_agent_card with a signed-card provider (integration)', () => {
  it('returns the signed AgentCard from the wired provider', async () => {
    runMigrations(getDb(), soulCapability);
    _resetReplayCacheForTests();
    const mainKp = crypto.generateKeyPairSync('ed25519');
    const keyDir = path.join(tmpDir, 'integration-keys');
    generateKeypair(keyDir);
    const loaded = loadKeypair(keyDir);
    const receiverDid = 'did:wba:host:agent:main';

    const signedCard = buildSignedAgentCard(
      {
        did: receiverDid,
        agentName: 'Andy',
        owner: 'Will',
        capabilities: [
          { name: 'web-browsing', description: 'browse', tier: 'trusted' },
        ],
        publicKeyRaw: loaded.publicKeyRaw,
        verificationMethodId: `${receiverDid}#key-1`,
      },
      loaded.privateKey,
    );

    fs.mkdirSync(path.join(tmpDir, 'main', 'soul', 'wiki'), {
      recursive: true,
    });
    const receiverCtx: SoulContext = {
      did: receiverDid,
      keyId: `${receiverDid}#key-1`,
      privateKey: mainKp.privateKey,
      folder: 'main',
      agentName: 'Andy',
      groupsDir: tmpDir,
      db: getDb(),
      getAgentCard: () => signedCard,
    };

    const callerDid = 'did:wba:host:agent:rust';
    const env = buildEnvelope({
      from: callerDid,
      to: receiverDid,
      verb: 'get_agent_card',
      body: {},
    });
    const callerKp = crypto.generateKeyPairSync('ed25519');
    const req = signMessage(env, callerKp.privateKey, `${callerDid}#key-1`);

    const res = await handleRequest(req, 'public', receiverCtx);
    const body = res.envelope.body as { card: typeof signedCard };
    expect(body.card.schemaVersion).toBe(AGENT_CARD_SCHEMA_VERSION);
    expect(body.card.did).toBe(receiverDid);
    expect('anp:signature' in body.card).toBe(true);
  });
});

// --- Phase 5 soul-registry ---

describe('soul-registry', () => {
  // Build a test ActiveSoul backed by a real keypair on disk under tmpDir.
  function makeSoul(
    folder: string,
    state: ActiveSoul['state'] = 'active',
  ): ActiveSoul {
    // Use a path that matches soulKeyDir's expectations — main's keypair
    // lives at <homedir>/.config/nanoclaw/soul, spawned souls at
    // <homedir>/.config/nanoclaw/soul/{folder}.
    const keyDir =
      folder === 'main'
        ? path.join(tmpDir, '.config', 'nanoclaw', 'soul')
        : path.join(tmpDir, '.config', 'nanoclaw', 'soul', folder);
    generateKeypair(keyDir);
    const loaded = loadKeypair(keyDir);
    return {
      folder,
      agentName: folder === 'main' ? 'Andy' : `${folder} soul`,
      did: `did:wba:host:agent:${folder}`,
      privateKey: loaded.privateKey,
      publicKey: loaded.publicKey,
      channelJid: folder === 'main' ? 'main@chat' : null,
      state,
    };
  }

  function insertSoulRow(
    folder: string,
    state: ActiveSoul['state'] = 'active',
  ): void {
    const now = '2026-05-29T00:00:00Z';
    getDb()
      .prepare(
        `INSERT INTO souls (folder, owner, channel_jid, agent_name, state,
                            spawned_at, state_changed_at, did, parent_folder, spawn_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        folder,
        'will',
        null,
        `${folder} soul`,
        state,
        now,
        now,
        `did:wba:host:agent:${folder}`,
        'main',
        'test',
      );
  }

  beforeEach(() => {
    runMigrations(getDb(), soulCapability);
    _clearRegistryForTests();
  });

  it('loadActiveSouls registers main even with no `souls` rows', () => {
    const main = makeSoul('main');
    const map = loadActiveSouls(getDb(), tmpDir, main);
    expect(map.size).toBe(1);
    expect(getSoul('main')).toEqual(main);
  });

  it('loadActiveSouls includes active and dormant rows, excludes archived', () => {
    insertSoulRow('project-rust', 'active');
    insertSoulRow('project-old', 'dormant');
    insertSoulRow('project-gone', 'archived');
    // Keypairs need to exist on disk for the loader; make them.
    makeSoul('project-rust', 'active');
    makeSoul('project-old', 'dormant');
    // project-gone is archived — we don't need its key.

    const main = makeSoul('main');
    loadActiveSouls(getDb(), tmpDir, main);

    expect(getSoul('main')).not.toBeNull();
    expect(getSoul('project-rust')?.state).toBe('active');
    expect(getSoul('project-old')?.state).toBe('dormant');
    expect(getSoul('project-gone')).toBeNull();
  });

  it('loadActiveSouls skips rows whose keypair is missing on disk', () => {
    insertSoulRow('project-orphan', 'active');
    // Deliberately do NOT call makeSoul for project-orphan — its key dir
    // does not exist, so loadKeypair throws.
    const main = makeSoul('main');
    loadActiveSouls(getDb(), tmpDir, main);
    expect(getSoul('project-orphan')).toBeNull();
    // Main is still loaded — one bad row doesn't tank the boot.
    expect(getSoul('main')).not.toBeNull();
  });

  it('getSoul returns null for an unknown folder', () => {
    loadActiveSouls(getDb(), tmpDir, makeSoul('main'));
    expect(getSoul('does-not-exist')).toBeNull();
  });

  it('listActiveSouls returns only state=active souls', () => {
    insertSoulRow('rust', 'active');
    insertSoulRow('quiet', 'dormant');
    makeSoul('rust', 'active');
    makeSoul('quiet', 'dormant');
    loadActiveSouls(getDb(), tmpDir, makeSoul('main'));

    const active = listActiveSouls();
    const folders = active.map((s) => s.folder).sort();
    expect(folders).toEqual(['main', 'rust']);
    // Dormant excluded.
    expect(folders).not.toContain('quiet');
  });

  it('resolvePublicKeyByDid returns the matching public key', () => {
    const main = makeSoul('main');
    loadActiveSouls(getDb(), tmpDir, main);
    const pub = resolvePublicKeyByDid('did:wba:host:agent:main');
    expect(pub).toBe(main.publicKey);
  });

  it('resolvePublicKeyByDid returns null for an unknown DID', () => {
    loadActiveSouls(getDb(), tmpDir, makeSoul('main'));
    expect(resolvePublicKeyByDid('did:wba:host:agent:ghost')).toBeNull();
  });

  it('round-trip: registerInMemory → listed → unregisterFromMemory → omitted → re-register', () => {
    loadActiveSouls(getDb(), tmpDir, makeSoul('main'));

    const rust = makeSoul('rust', 'active');
    registerInMemory(rust);
    expect(getSoul('rust')).toEqual(rust);
    expect(
      listActiveSouls()
        .map((s) => s.folder)
        .sort(),
    ).toEqual(['main', 'rust']);

    // Archive: unregister, registry omits it.
    unregisterFromMemory('rust');
    expect(getSoul('rust')).toBeNull();
    expect(listActiveSouls().map((s) => s.folder)).toEqual(['main']);

    // Resurrect: re-register, back in the list.
    registerInMemory(rust);
    expect(getSoul('rust')).toEqual(rust);
    expect(
      listActiveSouls()
        .map((s) => s.folder)
        .sort(),
    ).toEqual(['main', 'rust']);
  });

  it('registerInMemory throws on duplicate folder (caught at lifecycle layer)', () => {
    loadActiveSouls(getDb(), tmpDir, makeSoul('main'));
    expect(() => registerInMemory(makeSoul('main'))).toThrow(
      /already in registry/,
    );
  });

  it('updateSoulStateInMemory flips state and listActiveSouls reflects it', () => {
    insertSoulRow('rust', 'active');
    makeSoul('rust', 'active');
    loadActiveSouls(getDb(), tmpDir, makeSoul('main'));
    expect(
      listActiveSouls()
        .map((s) => s.folder)
        .sort(),
    ).toEqual(['main', 'rust']);

    updateSoulStateInMemory('rust', 'dormant');
    expect(getSoul('rust')?.state).toBe('dormant');
    expect(listActiveSouls().map((s) => s.folder)).toEqual(['main']);

    updateSoulStateInMemory('rust', 'active');
    expect(
      listActiveSouls()
        .map((s) => s.folder)
        .sort(),
    ).toEqual(['main', 'rust']);
  });

  it('updateSoulStateInMemory throws when the folder is not in the registry', () => {
    loadActiveSouls(getDb(), tmpDir, makeSoul('main'));
    expect(() => updateSoulStateInMemory('absent', 'dormant')).toThrow(
      /not in registry/,
    );
  });
});

// --- Phase 5 soul-lifecycle ---

describe('soul-lifecycle', () => {
  let lifecycleCtx: LifecycleContext;
  let transport: LoopbackTransport;
  let mainSoul: ActiveSoul;

  function buildMainSoul(): ActiveSoul {
    const keyDir = path.join(tmpDir, '.config', 'nanoclaw', 'soul');
    generateKeypair(keyDir);
    const loaded = loadKeypair(keyDir);
    return {
      folder: 'main',
      agentName: 'Andy',
      did: 'did:wba:host:agent:main',
      privateKey: loaded.privateKey,
      publicKey: loaded.publicKey,
      channelJid: 'main@chat',
      state: 'active',
    };
  }

  beforeEach(() => {
    runMigrations(getDb(), soulCapability);
    _clearRegistryForTests();
    fs.mkdirSync(path.join(tmpDir, 'main', 'soul', 'wiki'), {
      recursive: true,
    });
    transport = new LoopbackTransport();
    mainSoul = buildMainSoul();
    // Stub handler factory — echoes envelopes back. Tests don't exercise
    // the real verify+handle stack here; that's covered by handler tests.
    const buildSoulHandler =
      (_soul: ActiveSoul) => async (req: SignedMessage) =>
        req;
    lifecycleCtx = {
      db: getDb(),
      homedir: tmpDir,
      groupsDir: tmpDir,
      domain: 'host',
      mainFolder: 'main',
      transport,
      buildSoulHandler,
    };
    loadActiveSouls(getDb(), tmpDir, mainSoul);
    transport.registerSoul(mainSoul.did, buildSoulHandler(mainSoul));
  });

  it('exports the spec §17 constants', () => {
    expect(DORMANT_THRESHOLD_DAYS).toBe(30);
    expect(SPAWN_REASON_MAX_LEN).toBe(500);
  });

  it('spawnSoul rejects reserved folder names (main)', () => {
    expect(() =>
      spawnSoul(lifecycleCtx, {
        folder: 'main',
        agentName: 'X',
        parentFolder: 'main',
        spawnReason: 'try to clobber main',
      }),
    ).toThrow(/Reserved folder/);
  });

  it('spawnSoul rejects invalid folder slugs', () => {
    expect(() =>
      spawnSoul(lifecycleCtx, {
        folder: 'has spaces',
        agentName: 'X',
        parentFolder: 'main',
        spawnReason: 'r',
      }),
    ).toThrow(/Invalid folder slug/);
    expect(() =>
      spawnSoul(lifecycleCtx, {
        folder: 'has/slash',
        agentName: 'X',
        parentFolder: 'main',
        spawnReason: 'r',
      }),
    ).toThrow(/Invalid folder slug/);
  });

  it('spawnSoul rejects duplicate folder names', () => {
    spawnSoul(lifecycleCtx, {
      folder: 'project-rust',
      agentName: 'Rust',
      parentFolder: 'main',
      spawnReason: 'rust is a project',
    });
    expect(() =>
      spawnSoul(lifecycleCtx, {
        folder: 'project-rust',
        agentName: 'Rust Again',
        parentFolder: 'main',
        spawnReason: 'second attempt',
      }),
    ).toThrow(/Soul already exists/);
  });

  it('spawnSoul rejects empty or oversized spawn reasons', () => {
    expect(() =>
      spawnSoul(lifecycleCtx, {
        folder: 'a',
        agentName: 'X',
        parentFolder: 'main',
        spawnReason: '',
      }),
    ).toThrow(/spawnReason must not be empty/);
    expect(() =>
      spawnSoul(lifecycleCtx, {
        folder: 'b',
        agentName: 'X',
        parentFolder: 'main',
        spawnReason: 'x'.repeat(SPAWN_REASON_MAX_LEN + 1),
      }),
    ).toThrow(/SPAWN_REASON_MAX_LEN/);
  });

  it('spawnSoul creates wiki scaffold, per-soul key dir, souls row, registers in transport + registry, and does NOT create a per-soul curator task', () => {
    const soul = spawnSoul(lifecycleCtx, {
      folder: 'project-rust',
      agentName: 'Rust Soul',
      parentFolder: 'main',
      spawnReason: 'learning rust',
    });

    // Wiki scaffold exists.
    expect(
      fs.existsSync(
        path.join(tmpDir, 'project-rust', 'soul', 'wiki', '_index.md'),
      ),
    ).toBe(true);

    // Per-soul key dir is distinct from main's.
    const mainKeyDir = path.join(tmpDir, '.config', 'nanoclaw', 'soul');
    const spawnedKeyDir = path.join(
      tmpDir,
      '.config',
      'nanoclaw',
      'soul',
      'project-rust',
    );
    expect(spawnedKeyDir).not.toBe(mainKeyDir);
    expect(fs.existsSync(path.join(spawnedKeyDir, 'private-key.pem'))).toBe(
      true,
    );

    // DB row.
    const row = getDb()
      .prepare(`SELECT * FROM souls WHERE folder = ?`)
      .get('project-rust') as {
      folder: string;
      state: string;
      did: string;
      agent_name: string;
    };
    expect(row.state).toBe('active');
    expect(row.did).toBe('did:wba:host:agent:project-rust');
    expect(row.agent_name).toBe('Rust Soul');

    // Registry + transport know about it.
    expect(getSoul('project-rust')).not.toBeNull();
    expect(soul.did).toBe('did:wba:host:agent:project-rust');
    // Loopback can route to its DID.
    expect(transport.registeredCount()).toBeGreaterThanOrEqual(2); // main + project-rust

    // No per-soul curator task: main is the sole curator for every soul.
    expect(getTaskByIdFn('soul-wiki-curation-project-rust')).toBeUndefined();
  });

  it('two spawned souls get distinct key directories', () => {
    spawnSoul(lifecycleCtx, {
      folder: 'project-rust',
      agentName: 'Rust',
      parentFolder: 'main',
      spawnReason: 'learning rust',
    });
    spawnSoul(lifecycleCtx, {
      folder: 'project-scout',
      agentName: 'Scout',
      parentFolder: 'main',
      spawnReason: 'topic scouting for AI news',
    });
    const rustKey = path.join(
      tmpDir,
      '.config',
      'nanoclaw',
      'soul',
      'project-rust',
      'private-key.pem',
    );
    const scoutKey = path.join(
      tmpDir,
      '.config',
      'nanoclaw',
      'soul',
      'project-scout',
      'private-key.pem',
    );
    expect(fs.readFileSync(rustKey, 'utf-8')).not.toBe(
      fs.readFileSync(scoutKey, 'utf-8'),
    );
  });

  it('seedFromMainTopics copies wiki pages with attribution comment', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'main', 'soul', 'wiki', 'people.md'),
      '# People\n\nAlice likes brevity.\n',
      'utf-8',
    );
    spawnSoul(lifecycleCtx, {
      folder: 'project-rust',
      agentName: 'Rust',
      parentFolder: 'main',
      spawnReason: 'rust',
      seedFromMainTopics: ['people'],
    });
    const seeded = fs.readFileSync(
      path.join(tmpDir, 'project-rust', 'soul', 'wiki', 'people.md'),
      'utf-8',
    );
    expect(seeded).toContain('seeded from main wiki');
    expect(seeded).toContain('Alice likes brevity');
  });

  it('markDormant updates row + pauses tasks + keeps transport registration', () => {
    const soul = spawnSoul(lifecycleCtx, {
      folder: 'project-rust',
      agentName: 'Rust',
      parentFolder: 'main',
      spawnReason: 'rust',
    });
    markDormant(lifecycleCtx, 'project-rust');

    const row = getDb()
      .prepare(`SELECT state FROM souls WHERE folder = 'project-rust'`)
      .get() as { state: string };
    expect(row.state).toBe('dormant');
    expect(getSoul('project-rust')?.state).toBe('dormant');

    // Transport still registered — dormant souls are still queryable.
    expect(() => transport.registerSoul(soul.did, async (req) => req)).toThrow(
      /already registered/,
    );
  });

  it('markActive resumes a dormant soul', () => {
    spawnSoul(lifecycleCtx, {
      folder: 'project-rust',
      agentName: 'Rust',
      parentFolder: 'main',
      spawnReason: 'rust',
    });
    markDormant(lifecycleCtx, 'project-rust');
    markActive(lifecycleCtx, 'project-rust');

    expect(getSoul('project-rust')?.state).toBe('active');
  });

  it('markDormant/archive refuse to touch main', () => {
    expect(() => markDormant(lifecycleCtx, 'main')).toThrow(
      /Cannot make the main soul dormant/,
    );
    expect(() => archive(lifecycleCtx, 'main')).toThrow(
      /Cannot archive the main soul/,
    );
  });

  it('archive removes from registry + transport, pauses tasks, marks row', () => {
    const soul = spawnSoul(lifecycleCtx, {
      folder: 'project-rust',
      agentName: 'Rust',
      parentFolder: 'main',
      spawnReason: 'rust',
    });
    archive(lifecycleCtx, 'project-rust');

    const row = getDb()
      .prepare(`SELECT state FROM souls WHERE folder = 'project-rust'`)
      .get() as { state: string };
    expect(row.state).toBe('archived');
    expect(getSoul('project-rust')).toBeNull();
    // Transport now has the DID slot free — registering again works.
    expect(() =>
      transport.registerSoul(soul.did, async (req) => req),
    ).not.toThrow();
  });

  it('resurrect restores an archived soul to active state', () => {
    spawnSoul(lifecycleCtx, {
      folder: 'project-rust',
      agentName: 'Rust',
      parentFolder: 'main',
      spawnReason: 'rust',
    });
    archive(lifecycleCtx, 'project-rust');

    const restored = resurrect(lifecycleCtx, 'project-rust');
    expect(restored.state).toBe('active');
    expect(getSoul('project-rust')?.state).toBe('active');
  });

  it('resurrect refuses if soul is not archived', () => {
    spawnSoul(lifecycleCtx, {
      folder: 'project-rust',
      agentName: 'Rust',
      parentFolder: 'main',
      spawnReason: 'rust',
    });
    // Currently active — resurrect should refuse (soul already in registry).
    expect(() => resurrect(lifecycleCtx, 'project-rust')).toThrow(
      /already active/,
    );
  });

  it('resurrectRoutedSouls reactivates a dormant soul that received rows', () => {
    spawnSoul(lifecycleCtx, {
      folder: 'topic',
      agentName: 'T',
      parentFolder: 'main',
      spawnReason: 'x',
    });
    markDormant(lifecycleCtx, 'topic');
    expect(getSoul('topic')?.state).toBe('dormant');

    const woke = resurrectRoutedSouls(lifecycleCtx, ['topic']);
    expect(woke).toEqual(['topic']);
    expect(getSoul('topic')?.state).toBe('active');
  });

  it('resurrectRoutedSouls leaves active souls and unknown folders untouched', () => {
    spawnSoul(lifecycleCtx, {
      folder: 'topic2',
      agentName: 'T',
      parentFolder: 'main',
      spawnReason: 'x',
    });
    const woke = resurrectRoutedSouls(lifecycleCtx, ['topic2', 'nonexistent']);
    expect(woke).toEqual([]); // topic2 already active, nonexistent has no soul
    expect(getSoul('topic2')?.state).toBe('active');
  });

  it('sweepIdleSouls dormants an active soul idle >30d, keeps a recent one', () => {
    const now = new Date('2026-07-01T00:00:00Z');
    // idle: last routed row 40 days ago
    spawnSoul(lifecycleCtx, {
      folder: 'stale',
      agentName: 'S',
      parentFolder: 'main',
      spawnReason: 'x',
    });
    lifecycleCtx.db
      .prepare(`UPDATE souls SET spawned_at = '2026-05-01T00:00:00Z' WHERE folder='stale'`)
      .run();
    lifecycleCtx.db
      .prepare(
        `INSERT INTO memory_stream (id, group_folder, timestamp, type, source, content, importance, metadata, curated)
         VALUES ('r1','stale','2026-05-22T00:00:00Z','observation','router','x',5,NULL,0)`,
      )
      .run();
    // fresh: routed row 5 days ago
    spawnSoul(lifecycleCtx, {
      folder: 'fresh',
      agentName: 'F',
      parentFolder: 'main',
      spawnReason: 'x',
    });
    lifecycleCtx.db
      .prepare(`UPDATE souls SET spawned_at = '2026-05-01T00:00:00Z' WHERE folder='fresh'`)
      .run();
    lifecycleCtx.db
      .prepare(
        `INSERT INTO memory_stream (id, group_folder, timestamp, type, source, content, importance, metadata, curated)
         VALUES ('r2','fresh','2026-06-26T00:00:00Z','observation','router','x',5,NULL,0)`,
      )
      .run();

    const dormanted = sweepIdleSouls(lifecycleCtx, now);
    expect(dormanted).toEqual(['stale']);
    expect(getSoul('stale')?.state).toBe('dormant');
    expect(getSoul('fresh')?.state).toBe('active');
  });

  it('sweepIdleSouls uses spawned_at when there are no routed rows', () => {
    const now = new Date('2026-07-01T00:00:00Z');
    spawnSoul(lifecycleCtx, {
      folder: 'old',
      agentName: 'O',
      parentFolder: 'main',
      spawnReason: 'x',
    });
    lifecycleCtx.db
      .prepare(`UPDATE souls SET spawned_at='2026-05-01T00:00:00Z' WHERE folder='old'`)
      .run(); // 61d ago, no routed rows
    spawnSoul(lifecycleCtx, {
      folder: 'young',
      agentName: 'Y',
      parentFolder: 'main',
      spawnReason: 'x',
    });
    lifecycleCtx.db
      .prepare(`UPDATE souls SET spawned_at='2026-06-28T00:00:00Z' WHERE folder='young'`)
      .run(); // 3d ago, no routed rows

    expect(sweepIdleSouls(lifecycleCtx, now)).toEqual(['old']);
    expect(getSoul('young')?.state).toBe('active');
  });
});

// --- Phase 5 soul-router ---

describe('extractKeywords', () => {
  it('lowercases, splits on non-alnum, drops stopwords + tiny tokens, dedupes', () => {
    const kw = extractKeywords(
      'Will is learning Rust, including ownership and the borrow checker.',
    );
    expect(kw).toContain('learning');
    expect(kw).toContain('rust');
    expect(kw).toContain('ownership');
    expect(kw).toContain('borrow');
    expect(kw).toContain('checker');
    expect(kw).not.toContain('is');
    expect(kw).not.toContain('and');
    expect(kw).not.toContain('the');
  });

  it('returns empty array for empty / stopword-only input', () => {
    expect(extractKeywords('')).toEqual([]);
    expect(extractKeywords('the a and or')).toEqual([]);
  });

  it('drops short tokens (< 4 chars)', () => {
    const kw = extractKeywords('go is fun');
    expect(kw).not.toContain('go');
    expect(kw).not.toContain('is');
    expect(kw).not.toContain('fun');
  });
});

describe('routeUncuratedObservationsToSpawnedSouls', () => {
  beforeEach(() => {
    runMigrations(getDb(), soulCapability);
  });

  function insertSpawnedSoulRow(
    folder: string,
    spawnReason: string,
    state: 'active' | 'dormant' | 'archived' = 'active',
  ): void {
    const now = '2026-05-29T00:00:00Z';
    getDb()
      .prepare(
        `INSERT INTO souls (folder, owner, channel_jid, agent_name, state,
                            spawned_at, state_changed_at, did, parent_folder, spawn_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        folder,
        'self',
        null,
        `${folder} soul`,
        state,
        now,
        now,
        `did:wba:host:agent:${folder}`,
        'main',
        spawnReason,
      );
  }

  it('copies a matching main observation into the spawned soul memory_stream with backlink metadata', () => {
    insertSpawnedSoulRow(
      'project-rust',
      'learning rust, ownership, borrow checker',
    );
    const mainRowId = addMemory(getDb(), {
      groupFolder: 'main',
      timestamp: '2026-05-29T10:00:00Z',
      type: 'observation',
      source: 'whatsapp',
      content: 'I keep losing fights with the borrow checker.',
      importance: 5,
    });
    const res = routeUncuratedObservationsToSpawnedSouls(getDb(), 'main');
    expect(res.routed).toBe(1);
    expect(res.perFolder['project-rust']).toBe(1);

    const rustRows = getUncurated(getDb(), 'project-rust');
    expect(rustRows.length).toBe(1);
    expect(rustRows[0].content).toContain('borrow checker');
    expect(rustRows[0].source).toBe('router');
    const meta = JSON.parse(rustRows[0].metadata!);
    expect(meta.source_main_row_id).toBe(mainRowId);
    expect(meta.source_folder).toBe('main');
  });

  it('does NOT copy non-matching observations', () => {
    insertSpawnedSoulRow('project-rust', 'learning rust ownership lifetimes');
    addMemory(getDb(), {
      groupFolder: 'main',
      timestamp: '2026-05-29T10:00:00Z',
      type: 'observation',
      source: 'whatsapp',
      content: 'Pasta for dinner tonight.',
      importance: 5,
    });
    const res = routeUncuratedObservationsToSpawnedSouls(getDb(), 'main');
    expect(res.routed).toBe(0);
    expect(getUncurated(getDb(), 'project-rust').length).toBe(0);
  });

  it('is idempotent — second pass over the same row does not re-route', () => {
    insertSpawnedSoulRow('project-rust', 'learning rust ownership');
    addMemory(getDb(), {
      groupFolder: 'main',
      timestamp: '2026-05-29T10:00:00Z',
      type: 'observation',
      source: 'whatsapp',
      content: 'Stuck on rust ownership again.',
      importance: 5,
    });
    routeUncuratedObservationsToSpawnedSouls(getDb(), 'main');
    const second = routeUncuratedObservationsToSpawnedSouls(getDb(), 'main');
    expect(second.routed).toBe(0);
    expect(getUncurated(getDb(), 'project-rust').length).toBe(1);
  });

  it('does NOT route to archived souls', () => {
    insertSpawnedSoulRow('project-rust', 'learning rust ownership', 'archived');
    addMemory(getDb(), {
      groupFolder: 'main',
      timestamp: '2026-05-29T10:00:00Z',
      type: 'observation',
      source: 'whatsapp',
      content: 'Stuck on rust ownership.',
      importance: 5,
    });
    const res = routeUncuratedObservationsToSpawnedSouls(getDb(), 'main');
    expect(res.routed).toBe(0);
  });

  it('routes to dormant souls (so they can be resurrected)', () => {
    insertSpawnedSoulRow('k8s', 'monitoring kubernetes', 'dormant');
    addMemory(getDb(), {
      groupFolder: 'main',
      timestamp: '2026-05-29T10:00:00Z',
      type: 'observation',
      source: 'user',
      content: 'kubernetes autoscaling notes',
      importance: 5,
    });
    const res = routeUncuratedObservationsToSpawnedSouls(getDb(), 'main');
    expect(res.perFolder['k8s']).toBeGreaterThan(0);
  });

  it('returns {routed:0} early when there are no spawned souls', () => {
    addMemory(getDb(), {
      groupFolder: 'main',
      timestamp: '2026-05-29T10:00:00Z',
      type: 'observation',
      source: 'whatsapp',
      content: 'anything',
      importance: 5,
    });
    const res = routeUncuratedObservationsToSpawnedSouls(getDb(), 'main');
    expect(res).toEqual({ routed: 0, perFolder: {} });
  });
});

// --- Phase 5 spawn_soul intervention processing ---

describe('processPendingSpawnApprovals', () => {
  let lifecycleCtx: LifecycleContext;
  let transport: LoopbackTransport;

  function buildMainSoul(): ActiveSoul {
    const keyDir = path.join(tmpDir, '.config', 'nanoclaw', 'soul');
    generateKeypair(keyDir);
    const loaded = loadKeypair(keyDir);
    return {
      folder: 'main',
      agentName: 'Andy',
      did: 'did:wba:host:agent:main',
      privateKey: loaded.privateKey,
      publicKey: loaded.publicKey,
      channelJid: 'main@chat',
      state: 'active',
    };
  }

  function insertSpawnSoulIntervention(opts: {
    folder: string;
    agentName: string;
    keywords: string[];
    status: 'pending' | 'resolved';
    approved?: 0 | 1;
    actioned?: 0 | 1;
  }): string {
    return addMemory(getDb(), {
      groupFolder: 'main',
      timestamp: '2026-05-29T10:00:00Z',
      type: 'intervention',
      source: 'agent',
      content: `Spawn ${opts.folder}?`,
      importance: 8,
      metadata: {
        intervention_type: 'spawn_soul',
        question: `Spawn ${opts.folder}?`,
        context: `Topic emerged around ${opts.keywords.join(', ')}.`,
        proposed_folder: opts.folder,
        proposed_agent_name: opts.agentName,
        proposed_topic_keywords: opts.keywords,
        priority: 'medium',
        status: opts.status,
        ...(opts.approved !== undefined ? { approved: opts.approved } : {}),
        ...(opts.actioned !== undefined ? { actioned: opts.actioned } : {}),
      },
    });
  }

  beforeEach(() => {
    runMigrations(getDb(), soulCapability);
    _clearRegistryForTests();
    fs.mkdirSync(path.join(tmpDir, 'main', 'soul', 'wiki'), {
      recursive: true,
    });
    transport = new LoopbackTransport();
    const main = buildMainSoul();
    loadActiveSouls(getDb(), tmpDir, main);
    transport.registerSoul(main.did, async (req) => req);
    lifecycleCtx = {
      db: getDb(),
      homedir: tmpDir,
      groupsDir: tmpDir,
      domain: 'host',
      mainFolder: 'main',
      transport,
      buildSoulHandler: () => async (req) => req,
    };
  });

  it('spawns a soul for each resolved+approved spawn_soul intervention', () => {
    const id = insertSpawnSoulIntervention({
      folder: 'project-rust',
      agentName: 'Rust Soul',
      keywords: ['rust', 'ownership', 'borrow'],
      status: 'resolved',
      approved: 1,
    });
    const res = processPendingSpawnApprovals(lifecycleCtx);
    expect(res.spawned).toEqual(['project-rust']);
    expect(res.errors).toEqual([]);
    expect(getSoul('project-rust')).not.toBeNull();

    // Intervention is now marked actioned so a second pass is a no-op.
    const row = getDb()
      .prepare(
        `SELECT json_extract(metadata, '$.actioned') as actioned FROM memory_stream WHERE id = ?`,
      )
      .get(id) as { actioned: number | null };
    expect(row.actioned).toBe(1);

    const second = processPendingSpawnApprovals(lifecycleCtx);
    expect(second.spawned).toEqual([]);
  });

  it('skips pending interventions', () => {
    insertSpawnSoulIntervention({
      folder: 'project-rust',
      agentName: 'Rust',
      keywords: ['rust'],
      status: 'pending',
    });
    const res = processPendingSpawnApprovals(lifecycleCtx);
    expect(res.spawned).toEqual([]);
    expect(getSoul('project-rust')).toBeNull();
  });

  it('skips resolved but unapproved interventions', () => {
    insertSpawnSoulIntervention({
      folder: 'project-rust',
      agentName: 'Rust',
      keywords: ['rust'],
      status: 'resolved',
      approved: 0,
    });
    const res = processPendingSpawnApprovals(lifecycleCtx);
    expect(res.spawned).toEqual([]);
    expect(getSoul('project-rust')).toBeNull();
  });

  it('skips already-actioned interventions', () => {
    insertSpawnSoulIntervention({
      folder: 'project-rust',
      agentName: 'Rust',
      keywords: ['rust'],
      status: 'resolved',
      approved: 1,
      actioned: 1,
    });
    const res = processPendingSpawnApprovals(lifecycleCtx);
    expect(res.spawned).toEqual([]);
  });

  it('records an error and continues when proposed_folder is missing', () => {
    const id = addMemory(getDb(), {
      groupFolder: 'main',
      timestamp: '2026-05-29T10:00:00Z',
      type: 'intervention',
      source: 'agent',
      content: 'Spawn something?',
      importance: 8,
      metadata: {
        intervention_type: 'spawn_soul',
        question: 'Spawn?',
        status: 'resolved',
        approved: 1,
        // proposed_folder + proposed_agent_name intentionally omitted
      },
    });
    const res = processPendingSpawnApprovals(lifecycleCtx);
    expect(res.spawned).toEqual([]);
    expect(res.errors.length).toBe(1);
    expect(res.errors[0].interventionId).toBe(id);
    expect(res.errors[0].error).toMatch(/missing/);
  });
});

describe('planning-prompts: Phase 5 additions', () => {
  it('morning plan queries interventions across active souls', async () => {
    const { buildMorningPlanPrompt } = await import('./planning-prompts.js');
    const prompt = buildMorningPlanPrompt('main');
    expect(prompt).toContain('SELECT folder FROM souls');
    expect(prompt).toContain("state = 'active'");
    expect(prompt).toContain('spawn_soul');
  });
});

describe('curator-prompts: spawn_soul reconciliation', () => {
  it('evening journal explains spawn_soul approval semantics', async () => {
    const { buildEveningJournalPrompt } = await import('./curator-prompts.js');
    const prompt = buildEveningJournalPrompt('main');
    expect(prompt).toContain('spawn_soul');
    expect(prompt).toContain('approved');
  });
});

// --- Phase 5 cross-soul integration (full verify + handle + sign loop) ---

describe('cross-soul integration', () => {
  let lifecycleCtx: LifecycleContext;
  let transport: LoopbackTransport;
  let mainSoul: ActiveSoul;

  // Real soul handler: verify → handleRequest → signed response. Mirrors
  // what makeSoulHandlerFactory wires in index.ts.
  function makeRealHandler(soul: ActiveSoul): SignedRequestHandler {
    return async (req: SignedMessage) => {
      const verify = verifyMessage(req, {
        resolvePublicKey: resolvePublicKeyByDid,
        expectedTo: soul.did,
      });
      if (!verify.ok) {
        const errEnv = buildEnvelope({
          from: soul.did,
          to: req.envelope.from,
          verb: req.envelope.verb,
          body: { error: { code: 'verify_failed', message: verify.reason } },
        });
        return signMessage(errEnv, soul.privateKey, `${soul.did}#key-1`);
      }
      const sc: SoulContext = {
        did: soul.did,
        keyId: `${soul.did}#key-1`,
        privateKey: soul.privateKey,
        folder: soul.folder,
        agentName: soul.agentName,
        groupsDir: tmpDir,
        db: getDb(),
      };
      return handleRequest(req, LOOPBACK_DEFAULT_TIER, sc);
    };
  }

  function buildMain(): ActiveSoul {
    const keyDir = path.join(tmpDir, '.config', 'nanoclaw', 'soul');
    generateKeypair(keyDir);
    const loaded = loadKeypair(keyDir);
    return {
      folder: 'main',
      agentName: 'Andy',
      did: 'did:wba:host:agent:main',
      privateKey: loaded.privateKey,
      publicKey: loaded.publicKey,
      channelJid: 'main@chat',
      state: 'active',
    };
  }

  beforeEach(() => {
    runMigrations(getDb(), soulCapability);
    _clearRegistryForTests();
    _resetReplayCacheForTests();
    fs.mkdirSync(path.join(tmpDir, 'main', 'soul', 'wiki'), {
      recursive: true,
    });
    transport = new LoopbackTransport();
    mainSoul = buildMain();
    loadActiveSouls(getDb(), tmpDir, mainSoul);
    transport.registerSoul(mainSoul.did, makeRealHandler(mainSoul));
    lifecycleCtx = {
      db: getDb(),
      homedir: tmpDir,
      groupsDir: tmpDir,
      domain: 'host',
      mainFolder: 'main',
      transport,
      buildSoulHandler: makeRealHandler,
    };
  });

  it('main → spawned soul get_agent_card round-trips with a verifiable signed response', async () => {
    const rust = spawnSoul(lifecycleCtx, {
      folder: 'project-rust',
      agentName: 'Rust Soul',
      parentFolder: 'main',
      spawnReason: 'rust learning',
    });

    // Main sends get_agent_card to rust over the real transport.
    const env = buildEnvelope({
      from: mainSoul.did,
      to: rust.did,
      verb: 'get_agent_card',
      body: {},
    });
    const signed = signMessage(
      env,
      mainSoul.privateKey,
      `${mainSoul.did}#key-1`,
    );
    const res = await transport.send(rust.did, signed);

    // Response addressed back to main, signed by rust.
    expect(res.envelope.from).toBe(rust.did);
    expect(res.envelope.to).toBe(mainSoul.did);
    expect(res.signature.keyId).toBe(`${rust.did}#key-1`);

    // Re-verify the response signature using the registry's resolver — this
    // closes the loop: the same code path that production uses.
    const verifyRes = verifyMessage(res, {
      resolvePublicKey: resolvePublicKeyByDid,
      expectedTo: mainSoul.did,
    });
    expect(verifyRes.ok).toBe(true);

    // Body is rust's placeholder card (no provider wired in this test).
    const body = res.envelope.body as {
      card: { did: string; agentName: string };
    };
    expect(body.card.did).toBe(rust.did);
    expect(body.card.agentName).toBe('Rust Soul');
  });

  it('spawned → main propose_intervention lands in main memory_stream with origin attribution', async () => {
    const rust = spawnSoul(lifecycleCtx, {
      folder: 'project-rust',
      agentName: 'Rust Soul',
      parentFolder: 'main',
      spawnReason: 'rust learning',
    });

    const env = buildEnvelope({
      from: rust.did,
      to: mainSoul.did,
      verb: 'propose_intervention',
      body: {
        intervention_type: 'spawn_followup',
        question: 'Will missed his rust session — surface a check-in?',
        context: 'auto-detected from project-rust memory_stream',
        priority: 'medium',
      },
    });
    const signed = signMessage(env, rust.privateKey, `${rust.did}#key-1`);

    const res = await transport.send(mainSoul.did, signed);
    const body = res.envelope.body as {
      accepted: boolean;
      interventionId: string;
    };
    expect(body.accepted).toBe(true);

    const inserted = getDb()
      .prepare(`SELECT type, source, metadata FROM memory_stream WHERE id = ?`)
      .get(body.interventionId) as {
      type: string;
      source: string;
      metadata: string;
    };
    expect(inserted.type).toBe('intervention');
    expect(inserted.source).toBe('spawned-soul');
    const meta = JSON.parse(inserted.metadata);
    expect(meta.origin_folder).toBe('project-rust');
    expect(meta.origin_did).toBe(rust.did);
    expect(meta.status).toBe('pending');
  });

  it('rejects an envelope that was tampered with after signing (real verify path)', async () => {
    const rust = spawnSoul(lifecycleCtx, {
      folder: 'project-rust',
      agentName: 'Rust Soul',
      parentFolder: 'main',
      spawnReason: 'rust learning',
    });

    const env = buildEnvelope({
      from: mainSoul.did,
      to: rust.did,
      verb: 'get_agent_card',
      body: {},
    });
    const signed = signMessage(
      env,
      mainSoul.privateKey,
      `${mainSoul.did}#key-1`,
    );
    // Tamper: change the verb after signing.
    const tampered: SignedMessage = {
      ...signed,
      envelope: { ...signed.envelope, verb: 'query_state' },
    };

    const res = await transport.send(rust.did, tampered);
    const body = res.envelope.body as { error: { code: string } };
    expect(body.error.code).toBe('verify_failed');
  });

  it('end-to-end spawn via intervention: approval → host processes → newly-spawned soul is callable', async () => {
    // 1. Insert a resolved+approved spawn_soul intervention in main.
    addMemory(getDb(), {
      groupFolder: 'main',
      timestamp: '2026-05-29T10:00:00Z',
      type: 'intervention',
      source: 'agent',
      content: 'Spawn project-scout?',
      importance: 8,
      metadata: {
        intervention_type: 'spawn_soul',
        question: 'Spawn project-scout?',
        context: 'AI news scanning topic emerged',
        proposed_folder: 'project-scout',
        proposed_agent_name: 'Scout Soul',
        proposed_topic_keywords: ['scout', 'scanning', 'news'],
        status: 'resolved',
        approved: 1,
      },
    });

    // 2. Host scans + spawns.
    const res = processPendingSpawnApprovals(lifecycleCtx);
    expect(res.spawned).toEqual(['project-scout']);

    // 3. New soul is in registry + transport.
    const scout = getSoul('project-scout');
    expect(scout).not.toBeNull();

    // 4. Round-trip a message to the new soul through the real handler.
    const env = buildEnvelope({
      from: mainSoul.did,
      to: scout!.did,
      verb: 'get_agent_card',
      body: {},
    });
    const signed = signMessage(
      env,
      mainSoul.privateKey,
      `${mainSoul.did}#key-1`,
    );
    const reply = await transport.send(scout!.did, signed);
    expect(reply.envelope.from).toBe(scout!.did);
    expect(reply.envelope.to).toBe(mainSoul.did);
    const verifyRes = verifyMessage(reply, {
      resolvePublicKey: resolvePublicKeyByDid,
      expectedTo: mainSoul.did,
    });
    expect(verifyRes.ok).toBe(true);
  });

  it('archived soul: calls to its DID fail with "no handler" at the transport boundary', async () => {
    const rust = spawnSoul(lifecycleCtx, {
      folder: 'project-rust',
      agentName: 'Rust',
      parentFolder: 'main',
      spawnReason: 'rust',
    });

    archive(lifecycleCtx, 'project-rust');

    const env = buildEnvelope({
      from: mainSoul.did,
      to: rust.did,
      verb: 'get_agent_card',
      body: {},
    });
    const signed = signMessage(
      env,
      mainSoul.privateKey,
      `${mainSoul.did}#key-1`,
    );
    await expect(transport.send(rust.did, signed)).rejects.toThrow(
      /no handler/,
    );
  });

  it("per-channel budget invariant: spawned soul has no own budget file; main's budget is the only cap", () => {
    // Spawn two souls. Neither should create a proactive-budget.json under
    // groups/<folder>/soul/ — only main has the channel and the budget.
    spawnSoul(lifecycleCtx, {
      folder: 'project-rust',
      agentName: 'Rust',
      parentFolder: 'main',
      spawnReason: 'rust',
    });
    spawnSoul(lifecycleCtx, {
      folder: 'project-scout',
      agentName: 'Scout',
      parentFolder: 'main',
      spawnReason: 'scouting',
    });
    expect(
      fs.existsSync(
        path.join(tmpDir, 'project-rust', 'soul', 'proactive-budget.json'),
      ),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(tmpDir, 'project-scout', 'soul', 'proactive-budget.json'),
      ),
    ).toBe(false);
  });
});
