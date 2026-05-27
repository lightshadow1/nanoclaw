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
} from './identity.js';
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
import { soulCapability } from './index.js';

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
    expect(count.n).toBe(4);

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

  function writePlan(folder: string, dateStr: string): void {
    const soulDir = path.join(tmpDir, folder, 'soul');
    fs.mkdirSync(soulDir, { recursive: true });
    fs.writeFileSync(
      path.join(soulDir, 'daily-plan.json'),
      JSON.stringify({ date: dateStr, items: [] }),
      'utf-8',
    );
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

  it('allows check-in at 2 PM with a fresh budget', async () => {
    pinClock(new Date(2026, 4, 15, 14, 0, 0)); // May 15, 2026, 2:00 PM local
    try {
      await soulCapability.init(ctx());
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

  it('skips check-in at 11 PM (quiet hours) even when the budget is fresh', async () => {
    pinClock(new Date(2026, 4, 15, 23, 0, 0));
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

  it('skips check-in at 5 AM (quiet hours) even when the budget is fresh', async () => {
    pinClock(new Date(2026, 4, 15, 5, 0, 0));
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

  it('skips check-in at 2 PM when budget is exhausted', async () => {
    pinClock(new Date(2026, 4, 15, 14, 0, 0));
    try {
      await soulCapability.init(ctx());
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

  async function fetchJson(
    p: string,
  ): Promise<{
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

describe('planning-prompts: Phase 4.5 additions', () => {
  it('buildMorningPlanPrompt references experiment-state.json and backoff rules', async () => {
    const { buildMorningPlanPrompt } = await import('./planning-prompts.js');
    const prompt = buildMorningPlanPrompt('main');
    expect(prompt).toContain('experiment-state.json');
    expect(prompt).toContain('thompson_ranking');
    expect(prompt).toContain('withdrawal_week');
    expect(prompt).toContain('outreach_multiplier');
    expect(prompt).toContain(String(MIN_OUTREACH_MULTIPLIER));
  });

  it('buildCheckInPrompt contains the Step 0 evaluation and experiment_episodes insert', async () => {
    const { buildCheckInPrompt } = await import('./planning-prompts.js');
    const prompt = buildCheckInPrompt('main');
    expect(prompt).toContain('Step 0');
    expect(prompt).toContain('experiment_episodes');
    expect(prompt).toContain('proximal');
    expect(prompt).toContain('withdrawal_week');
    expect(prompt).toContain('"sent"'); // the interim status
  });

  // Touch the constants so unused-import lint doesn't pull them later.
  it('exports the phase-4.5 tuning constants used in tests', () => {
    expect(DRIFT_ALERT_DELTA).toBeGreaterThan(0);
    expect(EPISODE_DECAY_DAYS).toBeGreaterThan(0);
  });
});
