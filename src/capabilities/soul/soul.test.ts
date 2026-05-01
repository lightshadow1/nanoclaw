import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { _initTestDatabase, getDb } from '../../db.js';
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
