# Research Journal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Monday research runs write dated write-ups into the owner's Obsidian vault, the host sends one short Telegram digest when they're all done, and owner comments in the vault get a reply within about 2 hours and steer the next run.

**Architecture:** Containers write the notes; the host only reads them. A new host module (`research-journal.ts`) scans the vault for unanswered CriticMarkup comments, which wakes the existing 2-hourly curation pass, and builds the weekly index and digest. A new Monday-only task (`soul-research-digest-main`) runs entirely inside its `beforeTaskRun` gate and never starts a container. The journal rules live in a code-managed section of main's `CLAUDE.md`, so soul prompts and the three DB task prompts can all point at one set of rules. Everything is enabled only when main has a read-write `notes` mount.

**Tech Stack:** TypeScript (ESM, Node ≥20), better-sqlite3, vitest, `yaml` (already a dependency), cron-parser.

**Spec:** `docs/superpowers/specs/2026-10-24-research-journal-design.md`

## Global Constraints

- Only main's containers write to the vault, at `/workspace/extra/notes`. The host reads the same vault at main's `notes` mount `hostPath` (`~/vaults/notes` on will-mini-s).
- Dates in note names, `run:`, steering and follow-ups are local dates in `TIMEZONE` (America/Toronto). Containers run in UTC, so prompts get today's date with `TZ=<TIMEZONE> date +%F` (tzdata is in the agent image; checked 2026-10-25).
- Telegram gets at most one digest per Monday, and none when every source is quiet and every run succeeded. The digest doesn't consume the proactive budget, and the four Monday sources stop sending their own messages.
- Comment pickup covers `Research Journal/` and `Inbox/` only. Never read or write `.obsidian/` or `.livesync/`.
- The curation gate must never start a container just to look. With no uncurated memory and no unhandled comment, it returns false.
- Bets keep their existing flow: the production pass inserts them, and only the check-in publishes them.
- Starts Monday 2026-10-26, with no backfill. It must be live on will-mini-s before 09:00 that day.
- Live deploys use a worktree build plus a `dist/` swap, never a reset of the live working tree (`CLAUDE.md`, "Staging Server Deploy", plus the `live-instance-host` memory).
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. **CriticMarkup inside code.** A note that *shows* CriticMarkup inside backticks or a fenced block must not count as an unhandled comment. Otherwise a container starts every 2 hours forever. Test: Task 1, "ignores claude comments, code, and unclosed comments".
2. **The owner replies to the agent's reply.** In a thread like `{>> a <<}{>> [author=claude] ok <<}{>> b <<}`, only `b` is unhandled. Test: Task 1, "reports only the unanswered tail of a thread".
3. **The Telegram send fails partway through Monday.** The next tick retries, the digest never goes out twice, and the index is written once. Test: Task 2, "retries a failed send without sending twice".
4. **A source never runs** (host down, crashed container). The digest still goes out at 18:00 and lists that source. A paused task is not waited for. Tests: Task 2, "goes out at the 18:00 deadline…" and "lists main, active souls, and active configured tasks".
5. **Comments that must be ignored:** comments in the owner's other notes, files in hidden folders, non-markdown files and half-typed comments. Tests: Task 1, the `scanVaultComments` test, and "ignores … unclosed comments".

---

## Setup (before Task 1)

- [ ] Create a worktree from `staging` (superpowers:using-git-worktrees). The main checkout has unrelated uncommitted Home Assistant work in `src/container-runner.ts` and `container/agent-runner/src/index.ts`, so don't touch those files.
- [ ] Copy the untracked spec and this plan into the worktree, then commit them: `git add docs/superpowers/specs/2026-10-24-research-journal-design.md docs/superpowers/plans/2026-10-25-research-journal.md && git commit -m "Add research journal design and plan"`.

---

### Task 1: Find unanswered vault comments

**Files:**
- Create: `src/capabilities/soul/research-journal.ts`
- Test: `src/capabilities/soul/research-journal.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const VAULT_CONTAINER_DIR = '/workspace/extra/notes';
  export const JOURNAL_DIR = 'Research Journal';
  export const INBOX_DIR = 'Inbox';
  export const CLAUDE_REPLY_TAG = '[author=claude]';
  export const VAULT_COMMENTS_FILE = 'vault-comments.json'; // in groups/<main>/soul/
  export interface VaultComment { file: string; line: number; text: string; urgent: boolean }
  export function findUnhandledComments(markdown: string): Omit<VaultComment, 'file'>[];
  export function scanVaultComments(vaultPath: string): VaultComment[];
  export function writeVaultCommentsFile(soulDir: string, comments: VaultComment[], now: Date): void;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
describe('findUnhandledComments', () => {
  it('reports an owner comment with its line', () => {
    expect(findUnhandledComments('# T\nText {>> dig deeper <<}\n')).toEqual([
      { line: 2, text: 'dig deeper', urgent: false },
    ]);
  });
  it('treats a comment followed by a claude reply as handled', () => {
    expect(findUnhandledComments('a {>> why? <<}{>> [author=claude] will check <<}')).toEqual([]);
    expect(findUnhandledComments('a {>> why? <<}\n  {>> [author=claude] will check <<}')).toEqual([]);
  });
  it('reads anchored comments and flags urgent ones', () => {
    expect(findUnhandledComments('{==Firecracker==}{>> ! benchmark it now <<}')).toEqual([
      { line: 1, text: '! benchmark it now', urgent: true },
    ]);
  });
  it('reports only the unanswered tail of a thread', () => {
    expect(
      findUnhandledComments('{>> a <<}{>> [author=claude] ok <<}{>> b <<}').map((c) => c.text),
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
  it('collapses multi-line comment text and reports the start line', () => {
    expect(findUnhandledComments('x\n{>> line one\nline two <<}')).toEqual([
      { line: 2, text: 'line one line two', urgent: false },
    ]);
  });
});

describe('scanVaultComments', () => {
  // write(rel, content) creates <vault>/<rel> with parent dirs; vault is a fresh tmp dir
  it('scans only Research Journal/ and Inbox/ markdown, skipping hidden folders', () => {
    write('Research Journal/Tasks/Scout/2026-10-26.md', 'x {>> more on MCP <<}');
    write('Inbox/Trip plan.md', '{>> add Seoul <<}');
    write('Projects/idea.md', '{>> owner note to self <<}');
    write('Research Journal/.trash/old.md', '{>> stale <<}');
    write('Inbox/raw.txt', '{>> not markdown <<}');
    expect(scanVaultComments(vault)).toEqual([
      { file: 'Inbox/Trip plan.md', line: 1, text: 'add Seoul', urgent: false },
      { file: 'Research Journal/Tasks/Scout/2026-10-26.md', line: 1, text: 'more on MCP', urgent: false },
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
    const saved = JSON.parse(fs.readFileSync(path.join(soulDir, 'vault-comments.json'), 'utf-8'));
    expect(saved).toEqual({ generated_at: '2026-10-26T14:00:00.000Z', comments: c });
    writeVaultCommentsFile(soulDir, [], new Date());
    expect(fs.existsSync(path.join(soulDir, 'vault-comments.json'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail.** Run: `npx vitest run src/capabilities/soul/research-journal.test.ts`. Expected: FAIL, because the module doesn't exist yet.

- [ ] **Step 3: Implement the parser and scanner in `research-journal.ts`**

  `findUnhandledComments` algorithm:
  1. Build a masked copy of the text of the same length. Replace fenced code blocks (from a fence line matching `/^\s{0,3}(```|~~~)/` to the closing fence, inclusive) and single-line inline code spans (`` /`[^`\n]*`/g ``) with spaces, keeping newlines.
  2. Run `/\{>>([\s\S]*?)<<\}/g` over the masked copy. For each match, take the body from the *original* text at the same offsets and trim it.
  3. Skip bodies that start with `CLAUDE_REPLY_TAG`.
  4. An owner comment is handled when the masked text right after it matches `/^\s*\{>>([\s\S]*?)<<\}/` and that body starts with `CLAUDE_REPLY_TAG`.
  5. For each unhandled comment, report:
     - `line`: the number of newlines before the match, plus 1;
     - `text`: the body with whitespace collapsed to single spaces, cut to 300 characters;
     - `urgent`: whether the body starts with `!`.

  `scanVaultComments`:
  - Walk `JOURNAL_DIR` and `INBOX_DIR` recursively using `readdirSync(withFileTypes)`.
  - Skip names that start with `.`. Read only `isFile()` entries ending in `.md`, so symlinks aren't followed.
  - Report `file` relative to the vault, with `/` separators.
  - Sort by `file`, then `line`.

  `writeVaultCommentsFile`:
  - When there are comments, write `{generated_at, comments}` (pretty-printed) and create `soulDir` if needed.
  - When there are none, delete the file if it exists.

- [ ] **Step 4: Run the tests and confirm they pass.** Run: `npx vitest run src/capabilities/soul/research-journal.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit.** `git add src/capabilities/soul/research-journal.ts src/capabilities/soul/research-journal.test.ts && git commit -m "Detect unanswered CriticMarkup comments in the notes vault"`

---

### Task 2: Weekly index and Monday digest

**Files:**
- Modify: `src/capabilities/soul/research-journal.ts`
- Test: `src/capabilities/soul/research-journal.test.ts`

**Interfaces:**
- Consumes: `JOURNAL_DIR` from Task 1.
- Produces:
  ```ts
  export const DIGEST_STATE_FILE = 'research-digest.json'; // in groups/<main>/soul/, {"lastDone":"YYYY-MM-DD"}
  export const DIGEST_DEADLINE_HOUR = 18;
  export const RESEARCH_DIGEST_SCHEDULE = '*/15 9-21 * * 1';
  export interface JournalConfig { tasks: Record<string, string> } // task id -> folder name under Tasks/
  export function loadJournalConfig(configPath: string): JournalConfig;
  export function resolveVaultPath(db: Database.Database, mainFolder: string, homeDir: string): string | null;
  export function localDateString(d: Date): string; // YYYY-MM-DD in process-local time
  export interface JournalSource { label: string; dir: string; taskId: string; kind: 'soul' | 'task' }
  export function listJournalSources(db: Database.Database, mainFolder: string, config: JournalConfig): JournalSource[];
  export type SourceOutcome =
    | { source: JournalSource; state: 'written'; flags: number | null; summary: string }
    | { source: JournalSource; state: 'not-finished'; reason: string };
  export function collectOutcomes(db: Database.Database, vaultPath: string, sources: JournalSource[], runDate: string): SourceOutcome[];
  export function betsProposedOn(db: Database.Database, runDate: string): string[]; // group_folder per bet
  export function renderWeeklyIndex(runDate: string, outcomes: SourceOutcome[], betFolders: string[]): string;
  export function renderDigest(runDate: string, outcomes: SourceOutcome[], betFolders: string[]): string | null;
  export interface DigestDeps {
    db: Database.Database; vaultPath: string; soulDir: string; config: JournalConfig;
    mainFolder: string; now: Date; send: (text: string) => Promise<unknown>;
  }
  export function runResearchDigest(deps: DigestDeps): Promise<'already-done' | 'not-ready' | 'sent' | 'quiet'>;
  ```

**Test setup:**
- Use `_initTestDatabase()` and `runMigrations(getDb(), soulCapability)` (this creates the `souls` and `bets` tables) and a tmp vault.
- `MONDAY = '2026-10-26'` and `at = (h, m = 0) => new Date(2026, 9, 26, h, m)`. These are local-time constructors, so the tests pass in any time zone.
- Helpers:
  - `logRun(taskId, when, status = 'success', result = 'done', error = null)` inserts into `task_run_logs (task_id, run_at, duration_ms, status, result, error)`.
  - `note(dir, flags, summary)` writes `<vault>/<dir>/2026-10-26.md` with `type/source/run/status/flags/summary` frontmatter.
  - `addTask(id, status)` mirrors `upsertSoulTask`'s `createTask` call.
  - `insertSoul(folder, state)` copies the helper in `soul.test.ts:322`.
  - `insertBet(folder, status, createdAt)` inserts into `bets` with a fixed title and body.
  - `writeVault(rel, content)` is the same helper as in Task 1.
  - `mainSource` and `scoutSource` are the `JournalSource` literals from the first test below.

- [ ] **Step 1: Write the failing tests**

```ts
it('lists main, active souls, and active configured tasks', () => {
  insertSoul('travel-solo', 'active'); insertSoul('observability', 'dormant');
  addTask('t-scout', 'active'); addTask('t-paused', 'paused');
  expect(listJournalSources(getDb(), 'main', { tasks: { 't-scout': 'Scout', 't-paused': 'Paused', 't-gone': 'Gone' } })).toEqual([
    { label: 'main', dir: 'Research Journal/Souls/main', taskId: 'soul-production-main', kind: 'soul' },
    { label: 'travel-solo', dir: 'Research Journal/Souls/travel-solo', taskId: 'soul-production-main', kind: 'soul' },
    { label: 'Scout', dir: 'Research Journal/Tasks/Scout', taskId: 't-scout', kind: 'task' },
  ]);
});

it('collects outcomes from notes and run logs', () => {
  // sources: main, counsel (souls); Scout t-scout, AI Audit Observability t-audit, Solo Travel Research t-travel
  note('Research Journal/Souls/main', 0, 'nothing new');
  note('Research Journal/Tasks/Scout', 2, '2 flags (PwnEscape escape, MCP spec change)');
  logRun('soul-production-main', at(9, 30));
  logRun('t-scout', at(10, 20));
  logRun('t-audit', at(9, 5), 'timed_out', null, 'absolute timeout');
  logRun('t-travel', at(11, 2), 'error', null, 'container exited 1');
  expect(collectOutcomes(getDb(), vault, sources, MONDAY).map((o) =>
    o.state === 'written' ? [o.source.label, o.flags, o.summary] : [o.source.label, o.reason],
  )).toEqual([
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
  const [main, scout] = collectOutcomes(getDb(), vault, [mainSource, scoutSource], MONDAY);
  expect(main).toMatchObject({ state: 'written', flags: null, summary: '(no summary)' });
  expect(scout).toMatchObject({ state: 'not-finished', reason: 'did not run' });
});

it('counts bets created on the run date, except retracted ones', () => {
  // insertBet(folder, status, created_at) writes SQLite UTC 'YYYY-MM-DD HH:MM:SS'
  insertBet('agent-isolation', 'proposed', '2026-10-26 13:30:00');
  insertBet('counsel', 'retracted', '2026-10-26 13:40:00');
  insertBet('travel-solo', 'proposed', '2026-10-25 15:00:00');
  expect(betsProposedOn(getDb(), MONDAY)).toEqual(['agent-isolation']);
});

it('renders a digest with flagged, bets, not-finished and quiet lines', () => {
  expect(renderDigest(MONDAY, mixedOutcomes, ['agent-isolation'])).toBe([
    'Monday research — Oct 26',
    '• Scout: 2 flags (PwnEscape escape, MCP spec change)',
    '• Bets proposed: 1 (agent-isolation)',
    '• Not finished: AI Audit Observability (timed out)',
    '• Quiet: main, counsel',
    'Full write-ups → Research Journal/2026-10-26 Weekly',
  ].join('\n'));
  expect(renderDigest(MONDAY, allQuietAndWritten, [])).toBeNull();
  // a summary over 80 characters is cut to 79 characters plus '…'
});

it('renders the weekly index with links and failures', () => {
  const md = renderWeeklyIndex(MONDAY, mixedOutcomes, ['agent-isolation']);
  expect(md).toMatch(/^---\ntype: research-journal-index\nrun: 2026-10-26\n---\n# Monday research — 2026-10-26\n/);
  expect(md).toContain('- [[Research Journal/Tasks/Scout/2026-10-26|Scout]] — 2 flags (PwnEscape escape, MCP spec change)');
  expect(md).toContain('- AI Audit Observability — not finished (timed out)');
  expect(md).toContain('Bets proposed: 1 (agent-isolation)');
});

describe('runResearchDigest', () => {
  // deps(now, send = vi.fn().mockResolvedValue('m1')) uses config { tasks: { 't-scout': 'Scout' } }, soulDir = <tmp>/soul
  it('waits for every source before the deadline', async () => {
    logRun('soul-production-main', at(9, 30));
    expect(await runResearchDigest(deps(at(12)))).toBe('not-ready');
    expect(fs.existsSync(indexPath)).toBe(false);
  });
  it('writes the index and sends one digest when all sources are done, then stays done', async () => {
    // both runs logged, main note flags 0, Scout note flags 1
    const send = vi.fn().mockResolvedValue('m1');
    expect(await runResearchDigest(deps(at(12), send))).toBe('sent');
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toMatch(/^Monday research — Oct 26\n/);
    expect(fs.existsSync(indexPath)).toBe(true);
    expect(await runResearchDigest(deps(at(12, 15), send))).toBe('already-done');
    expect(send).toHaveBeenCalledOnce();
  });
  it('sends nothing on a quiet, complete week', async () => {
    logRun('soul-production-main', at(9, 30)); logRun('t-scout', at(10, 20));
    note('Research Journal/Souls/main', 0, 'nothing new'); note('Research Journal/Tasks/Scout', 0, '11 topics quiet');
    const send = vi.fn();
    expect(await runResearchDigest(deps(at(12), send))).toBe('quiet');
    expect(send).not.toHaveBeenCalled();
    expect(fs.existsSync(indexPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(soulDir, 'research-digest.json'), 'utf-8'))).toEqual({ lastDone: MONDAY });
  });
  it('goes out at the 18:00 deadline listing runs that never happened', async () => {
    // only production logged, main note flags 0
    const send = vi.fn().mockResolvedValue('m1');
    expect(await runResearchDigest(deps(at(18), send))).toBe('sent');
    expect(send.mock.calls[0][0]).toContain('• Not finished: Scout (did not run)');
  });
  it('retries a failed send without sending twice', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('telegram down'));
    await expect(runResearchDigest(deps(at(12), failing))).rejects.toThrow('telegram down');
    expect(fs.existsSync(path.join(soulDir, 'research-digest.json'))).toBe(false);
    const ok = vi.fn().mockResolvedValue('m2');
    expect(await runResearchDigest(deps(at(12, 15), ok))).toBe('sent');
    expect(ok).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run them and confirm they fail.** Run: `npx vitest run src/capabilities/soul/research-journal.test.ts`. Expected: FAIL on the missing exports.

- [ ] **Step 3: Implement the functions in `research-journal.ts`**

  `loadJournalConfig`:
  - A missing file gives `{tasks: {}}`.
  - Invalid JSON or the wrong shape logs a `logger.warn` and gives `{tasks: {}}`.
  - Drop any task whose name is empty, contains `/` or `\`, or starts with `.`.

  `resolveVaultPath`:
  - Read `container_config` from `registered_groups` where `folder = mainFolder`.
  - Find the mount where `(containerPath ?? basename(hostPath)) === 'notes'` and `readonly === false`.
  - Expand a leading `~` with `homeDir`.
  - Return the path only if it is an existing directory, otherwise `null`. Any error also gives `null`.

  `listJournalSources` returns sources in this order:
  1. main;
  2. active souls other than main, ordered by folder;
  3. config tasks in config order, keeping only those that exist with `status = 'active'`.

  `collectOutcomes`:
  - If `<dir>/<runDate>.md` exists, the source is `written`.
    - Parse frontmatter with `yaml` (the block between a leading `---` line and the next `---` line).
    - `flags` is the value when it is a non-negative integer, otherwise `null`.
    - `summary` is the trimmed string, or `'(no summary)'`.
  - Otherwise, look at the latest `task_run_logs` row whose `run_at` local date is `runDate`:
    - no row: `did not run`;
    - `timed_out`: `timed out`;
    - `error`: `failed: <error, first 60 characters>`;
    - a result starting with `skipped:`: `skipped`;
    - any other success: `no write-up`.

  `betsProposedOn`:
  - Read rows with `status != 'retracted'`.
  - Convert `created_at` to a Date: SQLite `YYYY-MM-DD HH:MM:SS` is UTC, so turn the space into `T` and append `Z`; ISO strings parse as they are.
  - Keep rows whose local date is `runDate`, ordered by `created_at`.

  `renderDigest`:
  - A source is flagged when it is `written` with `flags !== 0` (this includes `null`), and quiet when it is `written` with `flags === 0`.
  - Return `null` when there are no flagged sources, no not-finished sources and no bets.
  - Otherwise produce these lines in order, leaving out any group that is empty:
    1. the header, built from the `runDate` parts (no Date parsing);
    2. one line per flagged source, with the summary cut to 80 characters;
    3. the bets line;
    4. one `Not finished:` line listing `label (reason)`, comma-separated;
    5. the `Quiet:` line;
    6. the footer.

  `renderWeeklyIndex`:
  - Include a `## Souls` section and a `## Tasks` section, leaving out empty ones.
  - Written sources become `- [[<dir>/<runDate>|<label>]] — <summary>`.
  - Unfinished sources become `- <label> — not finished (<reason>)`.
  - End with the bets line when there are bets.

  `runResearchDigest`:
  1. Set `runDate = localDateString(now)`. If the state file's `lastDone === runDate`, return `'already-done'`.
  2. Find the sources. If not every distinct `taskId` has a run on `runDate` and `now.getHours() < DIGEST_DEADLINE_HOUR`, return `'not-ready'`.
  3. Collect the outcomes and bets. If `<vault>/Research Journal/<runDate> Weekly.md` doesn't exist, write it, creating the folder if needed.
  4. Render the digest. If there is one, `await send(text)` and let errors propagate.
  5. Write `{lastDone: runDate}`. Return `'sent'` if a digest went out, otherwise `'quiet'`.

- [ ] **Step 4: Run the tests and confirm they pass.** Run: `npx vitest run src/capabilities/soul/research-journal.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit.** `git commit -am "Build the research journal weekly index and Monday digest"`

---

### Task 3: Journal rules and prompt text

**Files:**
- Create: `src/capabilities/soul/research-journal-prompts.ts`
- Modify: `src/capabilities/soul/curator-prompts.ts` (`buildWikiCurationPrompt`)
- Modify: `src/capabilities/soul/planning-prompts.ts` (`buildProductionPrompt`)
- Test: `src/capabilities/soul/research-journal.test.ts`

**Interfaces:**
- Consumes: `VAULT_CONTAINER_DIR`, `JOURNAL_DIR`, `INBOX_DIR`, `CLAUDE_REPLY_TAG` and `VAULT_COMMENTS_FILE` from Task 1.
- Produces:
  ```ts
  export interface JournalPromptOptions { timezone: string } // IANA zone, from TIMEZONE
  export const NOTES_VAULT_MARKER = '<!-- notes-vault-section -->';
  export const NOTES_VAULT_END_MARKER = '<!-- /notes-vault-section -->';
  export function buildNotesVaultSection(o: JournalPromptOptions): string; // starts with NOTES_VAULT_MARKER, ends with NOTES_VAULT_END_MARKER
  export const RESEARCH_DIGEST_TASK_PROMPT: string;
  // changed signatures (no options = prompt text unchanged from today):
  buildWikiCurationPrompt(folder: string, journal?: JournalPromptOptions): string
  buildProductionPrompt(folder: string, journal?: JournalPromptOptions): string
  ```

- [ ] **Step 1: Write the failing tests**

```ts
describe('research journal prompts', () => {
  const o = { timezone: 'America/Toronto' };
  it('vault section carries the vault, chat-vs-note, comment and journal rules', () => {
    const s = buildNotesVaultSection(o);
    expect(s.startsWith('<!-- notes-vault-section -->')).toBe(true);
    expect(s.trimEnd().endsWith('<!-- /notes-vault-section -->')).toBe(true);
    for (const needle of ['TZ=America/Toronto date +%F', '/workspace/extra/notes', '.livesync/', 'source: telegram',
      'status: draft', '[author=claude]', 'Never delete', 'type: research-journal', 'summary:', '_Steering.md',
      '## Re-run', 'Following your steer', 'Quiet this week', '<internal>']) {
      expect(s).toContain(needle);
    }
    expect(s).not.toContain('delete the comment');
  });
  it('curation prompt gains the comment pass only with the journal', () => {
    expect(buildWikiCurationPrompt('main')).not.toContain('vault-comments.json');
    const p = buildWikiCurationPrompt('main', o);
    for (const needle of ['/workspace/group/soul/vault-comments.json', '{>> [author=claude]', '_Steering.md',
      '## Follow-up', 'TZ=America/Toronto date +%F']) expect(p).toContain(needle);
  });
  it('production prompt writes a note per soul and keeps the bet rules', () => {
    expect(buildProductionPrompt('main')).not.toContain('Research Journal');
    const p = buildProductionPrompt('main', o);
    for (const needle of ['/workspace/extra/notes/Research Journal/Souls/SOUL/', '_Steering.md',
      'still researched and written up', 'INSERT INTO bets', 'never messages the owner directly']) expect(p).toContain(needle);
    expect(p).not.toContain('Skip any soul that already has an open');
  });
});
```

- [ ] **Step 2: Run them and confirm they fail.** Run: `npx vitest run src/capabilities/soul/research-journal.test.ts -t "research journal prompts"`. Expected: FAIL.

- [ ] **Step 3: Write `buildNotesVaultSection`.** It replaces the hand-written "Notes Vault (Obsidian)" section that is live on will-mini-s. Use this copy, with `${tz}` set to `o.timezone`:

````md
<!-- notes-vault-section -->
## Notes Vault (Obsidian)

The owner's Obsidian vault is mounted read-write at `/workspace/extra/notes`. Self-hosted LiveSync syncs it with the owner's devices within seconds: what you write appears in their notes app almost immediately, and what they write appears here.

- Search and read it freely when the owner asks about their notes, plans, or ideas.
- Only change a note when the owner asks you to, when it has comments addressed to you, or when it is your own write-up under `Research Journal/`. Edit the specific lines; never rewrite a whole note.
- Never touch `.obsidian/` or `.livesync/`.
- Deleting or renaming a note deletes or renames it on every device. Ask first.
- Today's date is `TZ=${tz} date +%F` (the container clock is UTC). Use it for every date you write in the vault.

### Chat or note?

Quick answers, confirmations, back-and-forth and status stay in chat. These become a note in `Inbox/` instead: anything the owner will come back to, edit or share (plans, research write-ups, specs, comparisons, checklists, drafts); anything longer than a phone screen or with structure (headings, tables); anything the owner calls "save", "write up", "draft" or "note".

A new note starts with frontmatter `type: <plan|research|spec|comparison|checklist|draft|note>`, `created: <today>`, `source: telegram`, `status: draft`. Then reply in chat in 1–2 lines: what you made, the note's name, and the next step. Follow-up edits go into the same note. Ad-hoc research asked for in chat goes to `Inbox/`, never `Research Journal/`.

### Comments (CriticMarkup)

| Markup | Meaning |
|--------|---------|
| `{>> comment <<}` | Comment on the text just before it |
| `{==text==}{>> comment <<}` | Comment anchored to the highlighted text |
| `{++added++}` / `{--removed--}` / `{~~old~>new~~}` | Suggested insertion / deletion / replacement |

- An owner comment is an instruction about the text it is attached to. A comment starting with `!` is urgent.
- Never delete or reword an owner comment. Answer it with a reply placed immediately after it: `{>> [author=claude] <what you did or will do> <<}`. A comment counts as handled only when your reply directly follows it; the host checks every 2 hours and wakes you for unhandled ones.
- Start every comment you write with `[author=claude]`. An untagged comment looks like the owner's and will keep waking you.
- When writing *about* CriticMarkup, put examples in backticks so they aren't read as comments.
- When revising a note the owner has already read, propose changes as suggestions instead of editing silently, so they can accept or reject each one.
- Don't use HTML comments (`<!-- -->`) for feedback; the soul wiki uses them for its own markers.

### Research Journal

Scheduled research runs write to `Research Journal/Souls/<soul folder>/` or `Research Journal/Tasks/<task name>/`; the run tells you which.

1. Before researching, read `_Steering.md` in your source folder if it exists, and apply every unchecked steer.
2. After researching, write ONE note at `<source folder>/<today>.md`:

   ```
   ---
   type: research-journal
   source: <soul folder or task name>
   run: <today>
   status: unread
   flags: <findings that cross the run's flag bar; 0 when quiet>
   summary: "<bottom line, at most 80 characters>"
   ---
   # <source> — <today>
   <the bottom line as one sentence>
   ## <finding>            one section per finding: what changed, why it matters to the owner, sources as links, confidence (high/medium/low)
   ## Following your steer  only when steers applied: one line per steer saying what you did
   ## Quiet this week       what you checked and found unchanged, with the places checked
   ```

- A quiet run still writes a short note (`flags: 0`) as proof it ran.
- Report this week's findings. Don't restate the soul wiki or a knowledge base.
- If today's note already exists (a re-run), add a `## Re-run HH:MM` section at the end instead of rewriting it; it may hold owner comments.
- Mark one-off steers you applied as done in `_Steering.md`: `- [x] … — done <today>`.
- Write only inside your own source folder. The host writes the weekly index note.
- Don't message the owner about the write-up; the host sends one Monday digest after every run finishes. Wrap your final output in `<internal>...</internal>`.

`_Steering.md` is a checklist, kept by the comment pass and editable by the owner: `- [ ] (standing|once) <steer> — from [[<note>]], <date>`.
<!-- /notes-vault-section -->
````

  `RESEARCH_DIGEST_TASK_PROMPT`: `'Host-side task: the host builds and sends the Monday research digest itself. If you are reading this, reply only with <internal>noop</internal>.'`

- [ ] **Step 4: Add "Part 3" to `buildWikiCurationPrompt` when `journal` is given.** Insert it before `# Output`. Use lettered steps so the existing numbering stays the same:

```md
# Part 3 — Answer the owner's vault comments

A. Read /workspace/group/soul/vault-comments.json. If it is missing or lists no comments, skip this part. Each entry gives `file` (relative to /workspace/extra/notes), the `line` the comment starts on, its `text`, and `urgent`.
B. For each comment, open the note and find it. Skip it if a `{>> [author=claude] … <<}` reply already follows it. Otherwise:
   - In a `Research Journal/Souls/<folder>/` or `Research Journal/Tasks/<name>/` note, a comment usually steers future runs of that source: add it to that folder's `_Steering.md` as `(standing)` or `(once)` (create the file if missing). On a weekly index note, file each steer under the source it is about. In an `Inbox/` note, do what the comment asks, editing only that note.
   - If it is urgent (text starts with `!`), do the work now, research included, and append `## Follow-up <today>` to the note with the result.
   - Reply immediately after the comment: `{>> [author=claude] <one line: what you did, or what the next run will do> <<}`. Never delete or reword the owner's comment.
C. Today is `TZ=${tz} date +%F`. The reply in the note is the answer: leave comment handling out of your Output and don't message the owner about it.
```

- [ ] **Step 5: Add the journal steps to `buildProductionPrompt` when `journal` is given.** With no options the prompt stays byte-for-byte the same. With options:
  - Replace the two capacity bullets in step 2 with:
    - "A soul that already has an open (proposed or sent) bet gets no new bet this week, but is still researched and written up."
    - "If ${MAX_OPEN_BETS} or more bets are open in total, insert no bets this week. Still research and write up every soul."
  - Change step 3 to "For EACH soul (its folder below is SOUL)", now including main.
  - Add sub-step "0. Read `/workspace/extra/notes/Research Journal/Souls/SOUL/_Steering.md` if it exists and apply its unchecked steers."
  - Make the bet insert conditional on the soul being allowed a bet.
  - Add a final sub-step: "Write SOUL's journal note at `/workspace/extra/notes/Research Journal/Souls/SOUL/<today>.md` (today: `TZ=${tz} date +%F`), following the Research Journal rules in CLAUDE.md, with `source: SOUL`. flags = the findings worth the owner's attention this week (a proposed bet counts as one). Write it even when nothing cleared the bar."

- [ ] **Step 6: Run the tests and confirm they pass.** Run: `npx vitest run src/capabilities/soul`. Expected: PASS, including the existing `planning-prompts` and `curator-prompts` tests in `soul.test.ts`.

- [ ] **Step 7: Commit.** `git add src/capabilities/soul/research-journal-prompts.ts && git commit -am "Add research journal rules and journal-aware soul prompts"`

---

### Task 4: Wire the journal into the soul capability

**Files:**
- Modify: `src/capabilities/soul/index.ts`
  - `ensureClaudeMdSection` (lines 655–705), `ensureSoulTasks` (559–625) and `init` (884–946);
  - the `beforeTaskRun` curation branch (1022–1053) and production branch (1150–1160);
  - `todayLocalString` (777–782).
- Modify: `CLAUDE.md` (repo): the Soul Files list and the Scheduled Soul Tasks table.
- Test: `src/capabilities/soul/soul.test.ts`

**Interfaces:**
- Consumes: everything Tasks 1–3 produce.
- Produces: the task `soul-research-digest-main` (cron `RESEARCH_DIGEST_SCHEDULE`, profile `soul-maintenance`, prompt `RESEARCH_DIGEST_TASK_PROMPT`). The host config file is `~/.config/nanoclaw/research-journal.json`, shaped as `{"tasks": {"<task id>": "<folder name>"}}`.

- [ ] **Step 1: Write the failing tests** in a new `describe('research journal wiring')` block.

  Setup for this block:
  - In `beforeEach`, run `runMigrations(getDb(), soulCapability)` and `vi.spyOn(os, 'homedir').mockReturnValue(tmpDir)`, so the real `~/.config/nanoclaw/research-journal.json` is never read. Create `vault = <tmpDir>/vault`.
  - Call `setRegisteredGroup('g@g.us', { name: 'Main', folder: 'main', trigger: '@Andy', added_at: '2026-01-01T00:00:00Z', containerConfig: { additionalMounts: [{ hostPath: vault, containerPath: 'notes', readonly: false }] } })`.
  - The ctx is the usual `{ 'g@g.us': { name: 'Main', folder: 'main' } }` with `groupsDir: tmpDir`, plus an optional `sendMessage`.
  - In `afterEach`, run `vi.restoreAllMocks()`.
  - Add the helpers `writeVault(rel, content)`, `logRun(...)` (same as Task 2) and `curationTask()` (same as `soul.test.ts:733`) inside the block.

```ts
it('adds the vault section once and journal prompts when the vault is mounted', async () => {
  await soulCapability.init(ctx()); await soulCapability.teardown!();
  await soulCapability.init(ctx());
  const md = fs.readFileSync(path.join(tmpDir, 'main', 'CLAUDE.md'), 'utf-8');
  expect(md.match(/<!-- notes-vault-section -->/g)).toHaveLength(1);
  expect(md.match(/<!-- soul-section -->/g)).toHaveLength(1);
  expect(getTaskById('soul-wiki-curation-main')!.prompt).toContain('vault-comments.json');
  expect(getTaskById('soul-production-main')!.prompt).toContain('Research Journal/Souls/');
  const digest = getTaskById('soul-research-digest-main')!;
  expect(digest.schedule_value).toBe('*/15 9-21 * * 1');
  expect(digest.capability_profile).toBe('soul-maintenance');
  await soulCapability.teardown!();
});

it('changes nothing without a writable notes mount', async () => {
  setRegisteredGroup('g@g.us', { name: 'Main', folder: 'main', trigger: '@Andy', added_at: '2026-01-01T00:00:00Z' });
  await soulCapability.init(ctx());
  expect(fs.readFileSync(path.join(tmpDir, 'main', 'CLAUDE.md'), 'utf-8')).not.toContain('notes-vault-section');
  expect(getTaskById('soul-research-digest-main')).toBeUndefined();
  expect(getTaskById('soul-wiki-curation-main')!.prompt).not.toContain('vault-comments.json');
  await soulCapability.teardown!();
});

it('wakes curation for an unhandled vault comment and hands it over', async () => {
  await soulCapability.init(ctx());
  writeVault('Inbox/Trip.md', 'Plan {>> add Seoul <<}');
  expect(await soulCapability.hooks!.beforeTaskRun!(curationTask())).toBe(true);
  const handoff = path.join(tmpDir, 'main', 'soul', 'vault-comments.json');
  expect(JSON.parse(fs.readFileSync(handoff, 'utf-8')).comments[0].file).toBe('Inbox/Trip.md');
  writeVault('Inbox/Trip.md', 'Plan {>> add Seoul <<}{>> [author=claude] added <<}');
  expect(await soulCapability.hooks!.beforeTaskRun!(curationTask())).toBe(false);
  expect(fs.existsSync(handoff)).toBe(false);
  await soulCapability.teardown!();
});

it('runs the digest host-side and never starts a container', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 9, 26, 12, 0));
  try {
    const send = vi.fn().mockResolvedValue('1');
    await soulCapability.init(ctx(send));
    logRun('soul-production-main', new Date(2026, 9, 26, 9, 30));
    writeVault('Research Journal/Souls/main/2026-10-26.md',
      '---\ntype: research-journal\nsource: main\nrun: 2026-10-26\nstatus: unread\nflags: 1\nsummary: "one thing"\n---\n# main');
    const digestTask = { id: 'soul-research-digest-main', group_folder: 'main', schedule_type: 'cron' as const };
    expect(await soulCapability.hooks!.beforeTaskRun!(digestTask)).toBe(false);
    expect(send).toHaveBeenCalledWith('g@g.us', expect.stringContaining('• main: one thing'));
    await soulCapability.teardown!();
  } finally { vi.useRealTimers(); }
});
```

  Also replace the existing test "runs the production pass when below bet capacity and skips at capacity" (`soul.test.ts:1118`) with "always runs the production pass, even at bet capacity". It inserts 3 open bets and expects `true`.

- [ ] **Step 2: Run them and confirm they fail.** Run: `npx vitest run src/capabilities/soul/soul.test.ts -t "research journal wiring|production pass"`. Expected: FAIL.

- [ ] **Step 3: Implement the wiring in `index.ts`**
  - Generalize the CLAUDE.md helper to `ensureMarkedSection(claudePath: string, start: string, end: string, section: string): void`. Keep the existing semantics, including the legacy path where only a start marker exists. Call it for the soul section as now.
  - Add module state `let journal: { vaultPath: string; config: JournalConfig } | null = null`, and reset it in `teardown`.
  - In `init`, after the soul section:
    - set `vaultPath = resolveVaultPath(ctx.db, MAIN_GROUP_FOLDER, os.homedir())`;
    - if it's set, set `journal = { vaultPath, config: loadJournalConfig(path.join(os.homedir(), '.config', 'nanoclaw', 'research-journal.json')) }` and ensure the vault section;
    - log `{ vaultPath, tasks: Object.keys(config.tasks).length }` with the message `'Research journal enabled'`.
  - In `ensureSoulTasks`:
    - pass `journal ? { timezone: TIMEZONE } : undefined` to `buildWikiCurationPrompt` and `buildProductionPrompt`;
    - when `journal` is set, `upsertSoulTask` the digest task with `max_runtime_ms: SOUL_DEFAULT_RUNTIME_MS`.
  - Curation gate. After the memory check:
    - if `journal` is set, run `scanVaultComments(journal.vaultPath)`, then `writeVaultCommentsFile(path.join(groupsDir, MAIN_GROUP_FOLDER, 'soul'), comments, new Date())`;
    - return `pending !== undefined || comments.length > 0`;
    - a scan error logs and counts as no comments (fail closed, so a broken vault never starts a container every 2 hours).
  - Delete the production capacity gate. Production now falls through to `return true`.
  - Digest gate, for `soul-research-digest-<main>`:
    - if `journal`, `db`, `groupsDir`, `capCtx?.sendMessage` and `mainChatJid` are all available, `await runResearchDigest({... send: (t) => capCtx!.sendMessage!(mainChatJid!, t) })` and log the result at info;
    - catch and log any error;
    - always `return false`.
  - Replace `todayLocalString` with the imported `localDateString`.
  - In repo `CLAUDE.md`:
    - add `research-journal.ts` and `research-journal-prompts.ts` to Soul Files;
    - add a `soul-research-digest-main` row: "Monday every 15 min, 09:00–21:45. Host-only: once every Monday source has run (or at 18:00), writes the weekly index note and sends one digest unless the week was quiet. Never starts a container.";
    - change the production row: drop "Gated: skip when the ledger is at capacity", and add "writes one Research Journal note per soul when the vault is mounted";
    - add to the curation row: "also runs for unanswered vault comments (Part 3)".

- [ ] **Step 4: Run the full suite and the typecheck.** Run: `npx vitest run && npm run typecheck`. Expected: every test passes and tsc exits 0. Run `npx prettier --write` on the files you created or changed in `src/capabilities/soul/`.

- [ ] **Step 5: Commit.** `git commit -am "Wire the research journal into the soul capability"`

---

### Task 5: Deploy to will-mini-s (by 2026-10-25 night)

The live host is `will@100.108.8.72`, with the repo at `~/dev/nanoclaw` and node at `~/.nvm/versions/node/v24.13.1/bin` (prefix `export PATH=$HOME/.nvm/versions/node/v24.13.1/bin:$PATH &&`). The host has no `sqlite3` CLI, so database edits go through `node` with `better-sqlite3` from the repo's `node_modules`.

- [ ] **Step 1: Merge and push.** Merge the branch into `staging` and push to `origin/staging` (superpowers:finishing-a-development-branch).
- [ ] **Step 2: Pre-flight.** Run `ssh will@100.108.8.72 'cd ~/dev/nanoclaw && git fetch -q origin && git diff --stat origin/staging -- src/'`. Expected: only files under `src/capabilities/soul/` that this branch changed. If anything else differs, stop and ask the owner. It would be live-only host code that the build would drop.
- [ ] **Step 3: Build in a worktree.**
  ```
  cd ~/dev/nanoclaw && git worktree prune && rm -rf /tmp/nanoclaw-build
  git worktree add --detach /tmp/nanoclaw-build origin/staging
  ln -s ~/dev/nanoclaw/node_modules /tmp/nanoclaw-build/node_modules
  cd /tmp/nanoclaw-build && npx tsc -p . && npx vitest run src/capabilities/soul
  ```
  Expected: tsc exits 0 and the tests pass.
- [ ] **Step 4: Stop the service and take backups.** Run `systemctl --user stop nanoclaw`, then `cp groups/main/CLAUDE.md ~/.config/nanoclaw/backups/main-CLAUDE.md.$(date +%s)`.
- [ ] **Step 5: Remove the hand-written vault section.** Delete the lines from `## Notes Vault (Obsidian)` up to, but not including, `<!-- soul-section -->`. Expected: `grep -c '## Notes Vault (Obsidian)' groups/main/CLAUDE.md` prints `0`. Leave the Container Mounts row for `/workspace/extra/notes` in place.
- [ ] **Step 6: Write `~/.config/nanoclaw/research-journal.json`:**
  `{"tasks":{"task-1779934568728-ovail9":"Scout","task-1778899268392-3ejz43":"AI Audit Observability","task-1780425013963-uscus6":"Solo Travel Research"}}`
- [ ] **Step 7: Rewrite the three DB task prompts.** Write a node script in the scratchpad, `scp` it over, and run it from `~/dev/nanoclaw`. The script must:
  - back up all three current prompts to `~/.config/nanoclaw/backups/task-prompts-<ts>.json` first;
  - for each replacement, assert that `old` appears exactly once, and exit non-zero without writing anything if not;
  - update `scheduled_tasks.prompt` in a single transaction.

  The replacements (`J` = `/workspace/extra/notes/Research Journal/Tasks`):

  **AI Audit Observability** (`task-1778899268392-3ejz43`):
  - Replace "Summarize key findings and notable changes since the last check. Only send a message if there are significant new developments or trends worth reporting." with:
    > "Write up what you found as a Research Journal note (rules in CLAUDE.md, "Research Journal"). Your source folder is `J/AI Audit Observability/` and your source name is `AI Audit Observability`. First read `_Steering.md` there and last week's note, if they exist, and report only what changed since then. flags = significant new developments. Do not send any message to the owner; wrap your final output in <internal>...</internal>."

  **Scout** (`task-1779934568728-ovail9`), two replacements:
  - Replace "Step 1 — Locate sections. Run:" with:
    > "Step 0 — Steering. Read `J/Scout/_Steering.md` if it exists, and pass each unchecked steer to the subagent whose topics it concerns.\n\nStep 1 — Locate sections. Run:"
  - Replace `Step 5 — Message. Only send a message if there are FLAGGED items or meaningful DELTAS. If all topics show "no change", send a brief "All quiet this week" message.` with:
    > "Step 5 — Journal. Write this run's Research Journal note (rules in CLAUDE.md, "Research Journal") at `J/Scout/<today>.md`, source `Scout`. One section per FLAG or DELTA, built from the subagent's ENTRY and SOURCES; NO_CHANGE topics go under "Quiet this week", one line each. flags = number of FLAGGED topics. Do not send any message to the owner; wrap your final output in <internal>...</internal>."

  **Solo Travel Research** (`task-1780425013963-uscus6`):
  - "## Reporting Criteria:" → "## Flag Criteria:"
  - "**Only send message if ANY of these:**" → "**Flag a finding if ANY of these:**"
  - "**Message format:**" → "**Heading for each flagged finding:**"
  - "**If nothing interesting:** Don't send message (quiet is expected most weeks)" → "**If nothing interesting:** write a quiet note (quiet is expected most weeks)"
  - Then append:
    > "\n\n## Write-up\n\nWrite a Research Journal note (rules in CLAUDE.md, "Research Journal") at `J/Solo Travel Research/<today>.md`, source `Solo Travel Research`. Read `_Steering.md` in that folder first and apply it. flags = number of flagged findings; everything else you checked goes under "Quiet this week". Do not send any message to the owner; wrap your final output in <internal>...</internal>."

- [ ] **Step 8: Swap `dist/` and keep the source in step.** Run `mv dist dist.old.$(date +%s) && cp -a /tmp/nanoclaw-build/dist .`, then `git checkout origin/staging -- <the src files this branch changed>` so later in-place builds keep the change.
- [ ] **Step 9: Start and verify.** Run `systemctl --user start nanoclaw && systemctl --user is-active nanoclaw`, and expect `active`. Then check:
  - `grep -E "Research journal enabled|soul-research-digest-main|Soul task updated" logs/nanoclaw.log | tail` shows the journal enabled with `tasks: 3`, the digest task created, and the curation and production tasks updated.
  - `grep -c 'notes-vault-section -->' groups/main/CLAUDE.md` prints `2` (the start and end markers).
- [ ] **Step 10: Smoke-test the comment loop.**
  - Write `~/vaults/notes/Inbox/Journal smoke test.md` with the frontmatter `type: note, created: <today>, source: telegram, status: draft` and the body `Reply test. {>> please reply with the word ok <<}`.
  - Set `soul-wiki-curation-main.next_run` to now with node and better-sqlite3.
  - Wait until the note contains `{>> [author=claude]` right after the comment. Use the Monitor tool to poll every 30 s for up to 20 min.
  - Confirm no Telegram message mentioned it, then delete the smoke note.
- [ ] **Step 11: Clean up.** Run `rm /tmp/nanoclaw-build/node_modules && git worktree remove --force /tmp/nanoclaw-build`.

**Rollback:**
- move `dist.old.<ts>` back and restart;
- restore `main-CLAUDE.md.<ts>`;
- restore the prompts from `task-prompts-<ts>.json`;
- delete `research-journal.json`.

The digest task stays registered but has no effect without a vault.

---

### Task 6: Check the first Monday (2026-10-26, after 12:30 local)

- [ ] `~/vaults/notes/Research Journal/2026-10-26 Weekly.md` exists and lists 8 sources: main, the 4 active souls and the 3 tasks.
- [ ] Each written note has the frontmatter from the rules, and `logs/nanoclaw.log` shows `runResearchDigest` returning `sent` or `quiet`.
- [ ] Exactly one Monday research message appeared in Telegram (or none, on a quiet week), and none of the four sources sent its own message. `task_run_logs.result` for each of them starts with `<internal>`.
- [ ] If anything is off, report it to the owner with the log lines. Don't hot-fix live prompts without asking.
