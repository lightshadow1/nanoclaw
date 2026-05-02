import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { _initTestDatabase, getDb, getTaskById } from '../../db.js';
import { runMigrations, rollbackCapability } from '../lifecycle.js';
import { clearHooks } from '../hooks.js';
import { heuristicScore } from './heuristic-score.js';
import { addMemory, getUncurated } from './memory-stream.js';
import { ensureWikiForGroup } from './wiki-scaffold.js';
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

  it('creates curation and evening journal tasks for the main group', async () => {
    await soulCapability.init({
      db: getDb(),
      registeredGroups: mainGroup,
      projectRoot: tmpDir,
      groupsDir: tmpDir,
      dataDir: tmpDir,
    });

    const curation = getTaskById('soul-wiki-curation-main');
    const journal = getTaskById('soul-evening-journal-main');

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
    expect(count.n).toBe(2);

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
