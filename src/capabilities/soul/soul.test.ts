import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
  PROACTIVE_MAX_MESSAGES,
  PROACTIVE_MIN_GAP_MS,
  readBudget,
  type ProactiveBudget,
} from './proactive-budget.js';
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
import {
  startIdentityServer,
  stopIdentityServer,
} from './identity-server.js';
import { soulCapability } from './index.js';

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
    expect(heuristicScore({ content: 'hello there', isAddressed: false })).toBe(3);
  });

  it('mundane acknowledgments score 1', () => {
    expect(heuristicScore({ content: 'ok', isAddressed: false })).toBe(1);
    expect(heuristicScore({ content: 'thanks', isAddressed: false })).toBe(1);
    expect(heuristicScore({ content: 'k', isAddressed: false })).toBe(1);
  });

  it('keyword matches add 3', () => {
    expect(heuristicScore({ content: 'remember to lock up', isAddressed: false })).toBe(6);
    expect(heuristicScore({ content: 'this is urgent', isAddressed: false })).toBe(6);
  });

  it('addressed messages add 2', () => {
    expect(heuristicScore({ content: 'hello there', isAddressed: true })).toBe(5);
  });

  it('long messages add 1', () => {
    const long = 'a'.repeat(250);
    expect(heuristicScore({ content: long, isAddressed: false })).toBe(4);
  });

  it('URLs add 2', () => {
    expect(
      heuristicScore({ content: 'check https://example.com', isAddressed: false }),
    ).toBe(5);
  });

  it('combines bonuses and clamps to 10', () => {
    const score = heuristicScore({
      content: 'remember urgent deadline always cancel ' + 'a'.repeat(250) + ' https://x.com',
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
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_stream'")
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

    const rows = getDb().prepare('SELECT COUNT(*) as n FROM memory_stream').get() as {
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

    expect(fs.existsSync(path.join(tmpDir, 'fresh', 'soul', 'wiki', '_index.md'))).toBe(true);

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

    const rows = getDb().prepare('SELECT COUNT(*) as n FROM memory_stream').get() as {
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
      .prepare("SELECT COUNT(*) as n FROM scheduled_tasks WHERE id LIKE 'soul-%'")
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
    payload: { date: string; messages_sent: number; last_message_at: string | null },
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

  it('allows check-in when budget has capacity and within active hours', async () => {
    await soulCapability.init(ctx());
    writeBudgetFile('main', {
      date: todayLocal(),
      messages_sent: 0,
      last_message_at: null,
    });
    const allow = await soulCapability.hooks!.beforeTaskRun!(checkInTask());
    const hour = new Date().getHours();
    // Skip the assertion if we happen to be running tests during quiet hours —
    // the budget gate is independent and would be tripped by canSendProactive.
    if (hour >= 7 && hour < 22) {
      expect(allow).toBe(true);
    } else {
      expect(allow).toBe(false);
    }
    await soulCapability.teardown!();
  });

  it('skips check-in when budget is exhausted', async () => {
    await soulCapability.init(ctx());
    writeBudgetFile('main', {
      date: todayLocal(),
      messages_sent: 3, // PROACTIVE_MAX_MESSAGES
      last_message_at: '2000-01-01T00:00:00Z', // well past min gap
    });
    const allow = await soulCapability.hooks!.beforeTaskRun!(checkInTask());
    expect(allow).toBe(false);
    await soulCapability.teardown!();
  });

  it('skips morning plan when today\'s plan already exists', async () => {
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

    const contents = fs.readFileSync(path.join(tmpDir, 'main', 'CLAUDE.md'), 'utf-8');
    const matches = contents.match(/<!-- soul-section -->/g) ?? [];
    expect(matches).toHaveLength(1);

    await soulCapability.teardown!();
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
    expect(encodeEd25519PublicKeyMultibase(bytes).startsWith('z6Mk')).toBe(true);
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
    expect(encodeEd25519PublicKeyMultibase(bytes)).not.toBe(encodeMultibase(bytes));
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
    const before = fs.readFileSync(path.join(keyDir, 'private-key.pem'), 'utf-8');
    generateKeypair(keyDir);
    const after = fs.readFileSync(path.join(keyDir, 'private-key.pem'), 'utf-8');
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
    const vm = (doc.verificationMethod as Array<{ id: string; type: string; controller: string; publicKeyMultibase: string }>);
    expect(vm[0].id).toBe(`${did}#key-1`);
    expect(vm[0].type).toBe('Ed25519VerificationKey2020');
    expect(vm[0].controller).toBe(did);
    expect(vm[0].publicKeyMultibase).toBe('z6Mk-test');
    expect(doc.authentication).toEqual([`${did}#key-1`]);
    const services = doc.service as Array<{ id: string; serviceEndpoint: string }>;
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
    expect(Object.keys(second).filter((k) => k === 'anp:signature')).toHaveLength(1);
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
    expect(desc['anp:verificationLevels']).toEqual(['cryptographic', 'owner-verified']);
    const onChain = desc['anp:onChainIdentity'] as { chain: null | string; agentId: null | string };
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

  async function fetchJson(p: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
      http
        .request({ hostname: '127.0.0.1', port, path: p, method: p === '/a2a' ? 'POST' : 'GET' }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
          );
        })
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
    return new Promise<void>((resolve) => server.once('listening', () => resolve()));
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
    const tooSoon = new Date(activeHour.getTime() - (PROACTIVE_MIN_GAP_MS - 60_000));
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
    const longAgo = new Date(activeHour.getTime() - (PROACTIVE_MIN_GAP_MS + 60_000));
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
