import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  _initTestDatabase,
  createTask,
  getDb,
  getTaskById,
  setRegisteredGroup,
} from '../../db.js';
import { runMigrations } from '../lifecycle.js';
import { soulCapability } from './index.js';
import { buildWikiCurationPrompt } from './curator-prompts.js';
import { buildProductionPrompt } from './planning-prompts.js';
import { buildNotesVaultSection } from './research-journal-prompts.js';
import {
  betsProposedOn,
  collectOutcomes,
  findUnhandledComments,
  listJournalSources,
  loadJournalConfig,
  renderDigest,
  resolveVaultPath,
  renderWeeklyIndex,
  runResearchDigest,
  scanVaultComments,
  writeVaultCommentsFile,
  type JournalSource,
  type SourceOutcome,
} from './research-journal.js';

let tmpDir: string;
let vault: string;
let soulDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-journal-test-'));
  vault = path.join(tmpDir, 'vault');
  soulDir = path.join(tmpDir, 'soul');
  fs.mkdirSync(vault);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeVault(rel: string, content: string): void {
  const full = path.join(vault, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
}

describe('findUnhandledComments', () => {
  it('reports an owner comment with its line', () => {
    expect(findUnhandledComments('# T\nText {>> dig deeper <<}\n')).toEqual([
      { line: 2, text: 'dig deeper', urgent: false },
    ]);
  });

  it('treats a comment followed by a claude reply as handled', () => {
    expect(
      findUnhandledComments('a {>> why? <<}{>> [author=claude] will check <<}'),
    ).toEqual([]);
    expect(
      findUnhandledComments(
        'a {>> why? <<}\n  {>> [author=claude] will check <<}',
      ),
    ).toEqual([]);
  });

  it('reads anchored comments and flags urgent ones', () => {
    expect(
      findUnhandledComments('{==Firecracker==}{>> ! benchmark it now <<}'),
    ).toEqual([{ line: 1, text: '! benchmark it now', urgent: true }]);
  });

  it('reports only the unanswered tail of a thread', () => {
    expect(
      findUnhandledComments('{>> a <<}{>> [author=claude] ok <<}{>> b <<}').map(
        (c) => c.text,
      ),
    ).toEqual(['b']);
  });

  it('ignores claude comments, code, and unclosed comments', () => {
    const md = [
      '{>> [author=claude] note <<}',
      'Use `{>> comment <<}` syntax',
      '```',
      '{>> example <<}',
      '```',
      '{>> half typed',
    ].join('\n');
    expect(findUnhandledComments(md)).toEqual([]);
  });

  it('accepts a reply on the next line of a blockquote or callout', () => {
    expect(
      findUnhandledComments('> Para {>> q <<}\n> {>> [author=claude] ok <<}'),
    ).toEqual([]);
  });

  it('ignores CriticMarkup inside double-backtick code spans', () => {
    expect(findUnhandledComments('Use ``{>> x <<}`` here')).toEqual([]);
  });

  it('collapses multi-line comment text and reports the start line', () => {
    expect(findUnhandledComments('x\n{>> line one\nline two <<}')).toEqual([
      { line: 2, text: 'line one line two', urgent: false },
    ]);
  });
});

describe('scanVaultComments', () => {
  it('scans only Research Journal/ and Inbox/ markdown, skipping hidden folders', () => {
    writeVault(
      'Research Journal/Tasks/Scout/2026-10-26.md',
      'x {>> more on MCP <<}',
    );
    writeVault('Inbox/Trip plan.md', '{>> add Seoul <<}');
    writeVault('Projects/idea.md', '{>> owner note to self <<}');
    writeVault('Research Journal/.trash/old.md', '{>> stale <<}');
    writeVault('Inbox/raw.txt', '{>> not markdown <<}');
    expect(scanVaultComments(vault)).toEqual([
      { file: 'Inbox/Trip plan.md', line: 1, text: 'add Seoul', urgent: false },
      {
        file: 'Research Journal/Tasks/Scout/2026-10-26.md',
        line: 1,
        text: 'more on MCP',
        urgent: false,
      },
    ]);
  });

  it('returns [] when neither folder exists', () => {
    expect(scanVaultComments(vault)).toEqual([]);
  });
});

describe('writeVaultCommentsFile', () => {
  it('writes the list and removes the file when the list is empty', () => {
    const c = [{ file: 'Inbox/a.md', line: 1, text: 'x', urgent: false }];
    writeVaultCommentsFile(soulDir, c, new Date('2026-10-26T14:00:00Z'));
    const saved = JSON.parse(
      fs.readFileSync(path.join(soulDir, 'vault-comments.json'), 'utf-8'),
    );
    expect(saved).toEqual({
      generated_at: '2026-10-26T14:00:00.000Z',
      comments: c,
    });
    writeVaultCommentsFile(soulDir, [], new Date());
    expect(fs.existsSync(path.join(soulDir, 'vault-comments.json'))).toBe(
      false,
    );
  });
});

// --- Weekly index and Monday digest ---

const MONDAY = '2026-10-26';
const at = (h: number, m = 0) => new Date(2026, 9, 26, h, m);

const mainSource: JournalSource = {
  label: 'main',
  dir: 'Research Journal/Souls/main',
  taskId: 'soul-production-main',
  kind: 'soul',
};
const counselSource: JournalSource = {
  label: 'counsel',
  dir: 'Research Journal/Souls/counsel',
  taskId: 'soul-production-main',
  kind: 'soul',
};
const scoutSource: JournalSource = {
  label: 'Scout',
  dir: 'Research Journal/Tasks/Scout',
  taskId: 't-scout',
  kind: 'task',
};
const auditSource: JournalSource = {
  label: 'AI Audit Observability',
  dir: 'Research Journal/Tasks/AI Audit Observability',
  taskId: 't-audit',
  kind: 'task',
};
const travelSource: JournalSource = {
  label: 'Solo Travel Research',
  dir: 'Research Journal/Tasks/Solo Travel Research',
  taskId: 't-travel',
  kind: 'task',
};

function addTask(id: string, status: 'active' | 'paused' = 'active'): void {
  createTask({
    id,
    group_folder: 'main',
    chat_jid: 'g@g.us',
    prompt: 'p',
    schedule_type: 'cron',
    schedule_value: '0 10 * * 1',
    context_mode: 'isolated',
    next_run: null,
    status,
    created_at: new Date().toISOString(),
  });
}

function logRun(
  taskId: string,
  when: Date,
  status: 'success' | 'error' | 'timed_out' = 'success',
  result: string | null = 'done',
  error: string | null = null,
): void {
  if (!getTaskById(taskId)) addTask(taskId);
  getDb()
    .prepare(
      `INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
       VALUES (?, ?, 1000, ?, ?, ?)`,
    )
    .run(taskId, when.toISOString(), status, result, error);
}

function note(dir: string, flags: number, summary: string): void {
  writeVault(
    `${dir}/${MONDAY}.md`,
    [
      '---',
      'type: research-journal',
      `source: ${path.basename(dir)}`,
      `run: ${MONDAY}`,
      'status: unread',
      `flags: ${flags}`,
      `summary: "${summary}"`,
      '---',
      `# ${path.basename(dir)} — ${MONDAY}`,
    ].join('\n'),
  );
}

function insertSoul(folder: string, state: 'active' | 'dormant'): void {
  getDb()
    .prepare(
      `INSERT INTO souls
         (folder, owner, channel_jid, agent_name, description, state,
          spawned_at, state_changed_at, did, parent_folder, spawn_reason)
       VALUES (?, 'self', NULL, ?, NULL, ?,
          '2026-04-24T00:00:00Z', '2026-04-24T00:00:00Z', ?, 'main', 'x')`,
    )
    .run(folder, folder, state, `did:wba:host:agent:${folder}`);
}

function insertBet(folder: string, status: string, createdAt: string): void {
  getDb()
    .prepare(
      `INSERT INTO bets (id, group_folder, title, body, status, created_at)
       VALUES (?, ?, 'Test bet', 'Body', ?, ?)`,
    )
    .run(
      `bet-${Math.random().toString(36).slice(2)}`,
      folder,
      status,
      createdAt,
    );
}

const mixedOutcomes: SourceOutcome[] = [
  { source: mainSource, state: 'written', flags: 0, summary: 'nothing new' },
  { source: counselSource, state: 'written', flags: 0, summary: 'quiet' },
  {
    source: scoutSource,
    state: 'written',
    flags: 2,
    summary: '2 flags (PwnEscape escape, MCP spec change)',
  },
  { source: auditSource, state: 'not-finished', reason: 'timed out' },
];

describe('research digest', () => {
  beforeEach(() => {
    _initTestDatabase();
    runMigrations(getDb(), soulCapability);
  });

  it('loads the task list, dropping unsafe names and bad files', () => {
    const file = path.join(tmpDir, 'research-journal.json');
    expect(loadJournalConfig(file)).toEqual({ tasks: {} });
    fs.writeFileSync(file, '{not json');
    expect(loadJournalConfig(file)).toEqual({ tasks: {} });
    fs.writeFileSync(
      file,
      JSON.stringify({
        tasks: { a: 'Scout', b: '../escape', c: '.hidden', d: '', e: 7 },
      }),
    );
    expect(loadJournalConfig(file)).toEqual({ tasks: { a: 'Scout' } });
  });

  it("resolves main's writable notes mount, expanding ~", () => {
    const home = path.join(tmpDir, 'home');
    fs.mkdirSync(path.join(home, 'vaults', 'notes'), { recursive: true });
    const group = (readonly: boolean) => ({
      name: 'Main',
      folder: 'main',
      trigger: '@Andy',
      added_at: '2026-01-01T00:00:00Z',
      containerConfig: {
        additionalMounts: [
          { hostPath: '~/vaults/notes', containerPath: 'notes', readonly },
        ],
      },
    });
    setRegisteredGroup('g@g.us', group(false));
    expect(resolveVaultPath(getDb(), 'main', home)).toBe(
      path.join(home, 'vaults', 'notes'),
    );
    setRegisteredGroup('g@g.us', group(true));
    expect(resolveVaultPath(getDb(), 'main', home)).toBeNull();
    expect(resolveVaultPath(getDb(), 'other', home)).toBeNull();
  });

  it('lists main, active souls, and active configured tasks', () => {
    insertSoul('travel-solo', 'active');
    insertSoul('observability', 'dormant');
    addTask('t-scout', 'active');
    addTask('t-paused', 'paused');
    expect(
      listJournalSources(getDb(), 'main', {
        tasks: { 't-scout': 'Scout', 't-paused': 'Paused', 't-gone': 'Gone' },
      }),
    ).toEqual([
      mainSource,
      {
        label: 'travel-solo',
        dir: 'Research Journal/Souls/travel-solo',
        taskId: 'soul-production-main',
        kind: 'soul',
      },
      scoutSource,
    ]);
  });

  it('collects outcomes from notes and run logs', () => {
    note('Research Journal/Souls/main', 0, 'nothing new');
    note(
      'Research Journal/Tasks/Scout',
      2,
      '2 flags (PwnEscape escape, MCP spec change)',
    );
    logRun('soul-production-main', at(9, 30));
    logRun('t-scout', at(10, 20));
    logRun('t-audit', at(9, 5), 'timed_out', null, 'absolute timeout');
    logRun('t-travel', at(11, 2), 'error', null, 'container exited 1');
    const sources = [
      mainSource,
      counselSource,
      scoutSource,
      auditSource,
      travelSource,
    ];
    expect(
      collectOutcomes(getDb(), vault, sources, MONDAY).map((o) =>
        o.state === 'written'
          ? [o.source.label, o.flags, o.summary]
          : [o.source.label, o.reason],
      ),
    ).toEqual([
      ['main', 0, 'nothing new'],
      ['counsel', 'no write-up'],
      ['Scout', 2, '2 flags (PwnEscape escape, MCP spec change)'],
      ['AI Audit Observability', 'timed out'],
      ['Solo Travel Research', 'failed: container exited 1'],
    ]);
  });

  it('reads a note without usable frontmatter as flagged, and a run from another day as did not run', () => {
    writeVault('Research Journal/Souls/main/2026-10-26.md', '# no frontmatter');
    logRun('t-scout', new Date(2026, 9, 19, 10, 0));
    const [main, scout] = collectOutcomes(
      getDb(),
      vault,
      [mainSource, scoutSource],
      MONDAY,
    );
    expect(main).toMatchObject({
      state: 'written',
      flags: null,
      summary: '(no summary)',
    });
    expect(scout).toMatchObject({
      state: 'not-finished',
      reason: 'did not run',
    });
  });

  it('counts bets created on the run date, except retracted ones', () => {
    insertBet('agent-isolation', 'proposed', '2026-10-26 13:30:00');
    insertBet('counsel', 'retracted', '2026-10-26 13:40:00');
    insertBet('travel-solo', 'proposed', '2026-10-25 15:00:00');
    expect(betsProposedOn(getDb(), MONDAY)).toEqual(['agent-isolation']);
  });

  it('renders a digest with flagged, bets, not-finished and quiet lines', () => {
    expect(renderDigest(MONDAY, mixedOutcomes, ['agent-isolation'])).toBe(
      [
        'Monday research — Oct 26',
        '• Scout: 2 flags (PwnEscape escape, MCP spec change)',
        '• Bets proposed: 1 (agent-isolation)',
        '• Not finished: AI Audit Observability (timed out)',
        '• Quiet: main, counsel',
        'Full write-ups → Research Journal/2026-10-26 Weekly',
      ].join('\n'),
    );
    expect(renderDigest(MONDAY, mixedOutcomes.slice(0, 2), [])).toBeNull();
    const long: SourceOutcome = {
      source: scoutSource,
      state: 'written',
      flags: 1,
      summary: 'x'.repeat(100),
    };
    expect(renderDigest(MONDAY, [long], [])).toContain(
      `• Scout: ${'x'.repeat(79)}…\n`,
    );
  });

  it('renders the weekly index with links and failures', () => {
    const md = renderWeeklyIndex(MONDAY, mixedOutcomes, ['agent-isolation']);
    expect(md).toMatch(
      /^---\ntype: research-journal-index\nrun: 2026-10-26\n---\n# Monday research — 2026-10-26\n/,
    );
    expect(md).toContain(
      '- [[Research Journal/Tasks/Scout/2026-10-26|Scout]] — 2 flags (PwnEscape escape, MCP spec change)',
    );
    expect(md).toContain('- AI Audit Observability — not finished (timed out)');
    expect(md).toContain('Bets proposed: 1 (agent-isolation)');
  });

  describe('runResearchDigest', () => {
    let indexPath: string;

    beforeEach(() => {
      addTask('t-scout');
      indexPath = path.join(vault, 'Research Journal', `${MONDAY} Weekly.md`);
    });

    function deps(
      now: Date,
      send: (text: string) => Promise<unknown> = vi
        .fn()
        .mockResolvedValue('m1'),
    ) {
      return {
        db: getDb(),
        vaultPath: vault,
        soulDir,
        config: { tasks: { 't-scout': 'Scout' } },
        mainFolder: 'main',
        now,
        send,
      };
    }

    it('waits for every source before the deadline', async () => {
      logRun('soul-production-main', at(9, 30));
      expect(await runResearchDigest(deps(at(12)))).toBe('not-ready');
      expect(fs.existsSync(indexPath)).toBe(false);
    });

    it('writes the index and sends one digest when all sources are done, then stays done', async () => {
      logRun('soul-production-main', at(9, 30));
      logRun('t-scout', at(10, 20));
      note('Research Journal/Souls/main', 0, 'nothing new');
      note('Research Journal/Tasks/Scout', 1, '1 flag (MCP spec change)');
      const send = vi.fn().mockResolvedValue('m1');
      expect(await runResearchDigest(deps(at(12), send))).toBe('sent');
      expect(send).toHaveBeenCalledOnce();
      expect(send.mock.calls[0][0]).toMatch(/^Monday research — Oct 26\n/);
      expect(fs.existsSync(indexPath)).toBe(true);
      expect(await runResearchDigest(deps(at(12, 15), send))).toBe(
        'already-done',
      );
      expect(send).toHaveBeenCalledOnce();
    });

    it('sends nothing on a quiet, complete week', async () => {
      logRun('soul-production-main', at(9, 30));
      logRun('t-scout', at(10, 20));
      note('Research Journal/Souls/main', 0, 'nothing new');
      note('Research Journal/Tasks/Scout', 0, '11 topics quiet');
      const send = vi.fn();
      expect(await runResearchDigest(deps(at(12), send))).toBe('quiet');
      expect(send).not.toHaveBeenCalled();
      expect(fs.existsSync(indexPath)).toBe(true);
      expect(
        JSON.parse(
          fs.readFileSync(path.join(soulDir, 'research-digest.json'), 'utf-8'),
        ),
      ).toEqual({ lastDone: MONDAY });
    });

    it('goes out at the 18:00 deadline listing runs that never happened', async () => {
      logRun('soul-production-main', at(9, 30));
      note('Research Journal/Souls/main', 0, 'nothing new');
      const send = vi.fn().mockResolvedValue('m1');
      expect(await runResearchDigest(deps(at(18), send))).toBe('sent');
      expect(send.mock.calls[0][0]).toContain(
        '• Not finished: Scout (did not run)',
      );
    });

    it('does nothing outside Monday daytime, even on an overdue tick', async () => {
      const send = vi.fn().mockResolvedValue('m1');
      // Tuesday evening after a restart, and Monday inside quiet hours.
      expect(
        await runResearchDigest(deps(new Date(2026, 9, 27, 19, 0), send)),
      ).toBe('off-schedule');
      expect(await runResearchDigest(deps(at(22, 30), send))).toBe(
        'off-schedule',
      );
      expect(send).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(vault, 'Research Journal'))).toBe(false);
    });

    it('retries a failed send without sending twice', async () => {
      logRun('soul-production-main', at(9, 30));
      logRun('t-scout', at(10, 20));
      note('Research Journal/Souls/main', 0, 'nothing new');
      note('Research Journal/Tasks/Scout', 1, '1 flag (MCP spec change)');
      const failing = vi.fn().mockRejectedValue(new Error('telegram down'));
      await expect(runResearchDigest(deps(at(12), failing))).rejects.toThrow(
        'telegram down',
      );
      expect(fs.existsSync(path.join(soulDir, 'research-digest.json'))).toBe(
        false,
      );
      expect(fs.existsSync(indexPath)).toBe(true);
      const ok = vi.fn().mockResolvedValue('m2');
      expect(await runResearchDigest(deps(at(12, 15), ok))).toBe('sent');
      expect(ok).toHaveBeenCalledOnce();
    });
  });
});

// --- Journal rules and prompt text ---

describe('research journal prompts', () => {
  const o = { timezone: 'America/Toronto' };

  it('vault section carries the vault, chat-vs-note, comment and journal rules', () => {
    const s = buildNotesVaultSection(o);
    expect(s.startsWith('<!-- notes-vault-section -->')).toBe(true);
    expect(s.trimEnd().endsWith('<!-- /notes-vault-section -->')).toBe(true);
    for (const needle of [
      'TZ=America/Toronto date +%F',
      '/workspace/extra/notes',
      '.livesync/',
      'source: telegram',
      'status: draft',
      '[author=claude]',
      'Never delete',
      'type: research-journal',
      'summary:',
      '_Steering.md',
      '## Re-run',
      'Following your steer',
      'Quiet this week',
      '<internal>',
    ]) {
      expect(s).toContain(needle);
    }
    expect(s).not.toContain('delete the comment');
  });

  it('curation prompt gains the comment pass only with the journal', () => {
    expect(buildWikiCurationPrompt('main')).not.toContain(
      'vault-comments.json',
    );
    const p = buildWikiCurationPrompt('main', o);
    for (const needle of [
      '/workspace/group/soul/vault-comments.json',
      '{>> [author=claude]',
      '_Steering.md',
      '## Follow-up',
      'TZ=America/Toronto date +%F',
      // Host and agent must agree on "handled", or the pass loops forever.
      'Never skip a listed comment',
      'write the reply first',
      // Comment replies must not leak into a Telegram summary.
      'never counts as a change',
    ]) {
      expect(p).toContain(needle);
    }
  });

  it('production prompt writes a note per soul and keeps the bet rules', () => {
    expect(buildProductionPrompt('main')).not.toContain('Research Journal');
    const p = buildProductionPrompt('main', o);
    for (const needle of [
      '/workspace/extra/notes/Research Journal/Souls/SOUL/',
      '_Steering.md',
      'still researched and written up',
      'INSERT INTO bets',
      'never messages the owner directly',
    ]) {
      expect(p).toContain(needle);
    }
    expect(p).not.toContain('Skip any soul that already has an open');
  });
});
