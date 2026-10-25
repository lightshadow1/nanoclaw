// Research journal: the host side of the owner's Obsidian vault.
//
// Containers write the journal notes (see research-journal-prompts.ts); the
// host only reads them. It finds owner comments that still need a reply, so
// the curation pass can be woken for them, and it builds the Monday weekly
// index and the single Telegram digest once every research run has finished.

import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { parse as parseYaml } from 'yaml';
import { logger } from '../../logger.js';

export const VAULT_CONTAINER_DIR = '/workspace/extra/notes';
export const JOURNAL_DIR = 'Research Journal';
export const INBOX_DIR = 'Inbox';
export const CLAUDE_REPLY_TAG = '[author=claude]';
export const VAULT_COMMENTS_FILE = 'vault-comments.json';

const COMMENT_TEXT_MAX = 300;

export interface VaultComment {
  file: string; // relative to the vault, '/'-separated
  line: number; // 1-based line the comment starts on
  text: string;
  urgent: boolean; // owner prefixed the comment with '!'
}

// Blank out fenced code blocks and inline code spans, keeping every offset
// and newline, so CriticMarkup shown as an example is never read as a comment.
function maskCode(markdown: string): string {
  const lines = markdown.split('\n');
  let inFence = false;
  const masked = lines.map((line) => {
    const isFence = /^\s{0,3}(```|~~~)/.test(line);
    if (inFence || isFence) {
      if (isFence) inFence = !inFence;
      return ' '.repeat(line.length);
    }
    return line.replace(/`[^`\n]*`/g, (span) => ' '.repeat(span.length));
  });
  return masked.join('\n');
}

const COMMENT_RE = /\{>>([\s\S]*?)<<\}/g;
const NEXT_COMMENT_RE = /^\s*\{>>([\s\S]*?)<<\}/;

export function findUnhandledComments(
  markdown: string,
): Omit<VaultComment, 'file'>[] {
  const masked = maskCode(markdown);
  const found: Omit<VaultComment, 'file'>[] = [];
  for (const match of masked.matchAll(COMMENT_RE)) {
    const start = match.index;
    const end = start + match[0].length;
    // Masking preserves offsets, so the body comes from the original text.
    const body = markdown.slice(start + 3, end - 3).trim();
    if (body.startsWith(CLAUDE_REPLY_TAG)) continue;
    const next = NEXT_COMMENT_RE.exec(masked.slice(end));
    if (next && next[1].trim().startsWith(CLAUDE_REPLY_TAG)) continue;
    found.push({
      line: masked.slice(0, start).split('\n').length,
      text: body.replace(/\s+/g, ' ').slice(0, COMMENT_TEXT_MAX),
      urgent: body.startsWith('!'),
    });
  }
  return found;
}

function markdownFilesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...markdownFilesUnder(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(full);
  }
  return files;
}

// Unanswered owner comments in Research Journal/ and Inbox/ — the only
// folders the agent answers comments in. The owner's other notes are theirs.
export function scanVaultComments(vaultPath: string): VaultComment[] {
  const comments: VaultComment[] = [];
  for (const dir of [JOURNAL_DIR, INBOX_DIR]) {
    for (const full of markdownFilesUnder(path.join(vaultPath, dir))) {
      const file = path.relative(vaultPath, full).split(path.sep).join('/');
      for (const c of findUnhandledComments(fs.readFileSync(full, 'utf-8'))) {
        comments.push({ file, ...c });
      }
    }
  }
  return comments.sort((a, b) =>
    a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1,
  );
}

// Hand the list to the curation container (it sees soulDir as
// /workspace/group/soul). No comments → no file, so a stale list never lingers.
export function writeVaultCommentsFile(
  soulDir: string,
  comments: VaultComment[],
  now: Date,
): void {
  const file = path.join(soulDir, VAULT_COMMENTS_FILE);
  if (comments.length === 0) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(soulDir, { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ generated_at: now.toISOString(), comments }, null, 2),
    'utf-8',
  );
}

// --- Weekly index and Monday digest -----------------------------------------

export const DIGEST_STATE_FILE = 'research-digest.json';
// Latest local hour to wait for missing runs before sending what we have.
export const DIGEST_DEADLINE_HOUR = 18;
// Monday, every 15 minutes, 09:00-21:45 local: ends before quiet hours.
export const RESEARCH_DIGEST_SCHEDULE = '*/15 9-21 * * 1';

const DIGEST_SUMMARY_MAX = 80;
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

// Which scheduled tasks write to Research Journal/Tasks/<name>/. Kept in
// ~/.config/nanoclaw/research-journal.json because task ids are per-instance.
export interface JournalConfig {
  tasks: Record<string, string>; // task id -> folder name under Tasks/
}

export function loadJournalConfig(configPath: string): JournalConfig {
  if (!fs.existsSync(configPath)) return { tasks: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      tasks?: unknown;
    };
    const tasks: Record<string, string> = {};
    if (raw.tasks && typeof raw.tasks === 'object') {
      for (const [id, name] of Object.entries(raw.tasks)) {
        if (
          typeof name === 'string' &&
          name !== '' &&
          !/[/\\]/.test(name) &&
          !name.startsWith('.')
        ) {
          tasks[id] = name;
        }
      }
    }
    return { tasks };
  } catch (err) {
    logger.warn({ err, configPath }, 'Unreadable research journal config');
    return { tasks: {} };
  }
}

// Host path of main's writable `notes` mount — the same folder the
// containers see at VAULT_CONTAINER_DIR. Null when there is no such mount.
export function resolveVaultPath(
  db: Database.Database,
  mainFolder: string,
  homeDir: string,
): string | null {
  try {
    const row = db
      .prepare(
        'SELECT container_config FROM registered_groups WHERE folder = ?',
      )
      .get(mainFolder) as { container_config: string | null } | undefined;
    if (!row?.container_config) return null;
    const config = JSON.parse(row.container_config) as {
      additionalMounts?: {
        hostPath: string;
        containerPath?: string;
        readonly?: boolean;
      }[];
    };
    const mount = (config.additionalMounts ?? []).find(
      (m) =>
        (m.containerPath ?? path.basename(m.hostPath)) === 'notes' &&
        m.readonly === false,
    );
    if (!mount) return null;
    const hostPath = mount.hostPath.startsWith('~')
      ? path.join(homeDir, mount.hostPath.slice(1))
      : mount.hostPath;
    const resolved = path.resolve(hostPath);
    return fs.statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

export function localDateString(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
    2,
    '0',
  )}-${String(d.getDate()).padStart(2, '0')}`;
}

// [start, end) of a local calendar day as ISO strings, comparable with
// task_run_logs.run_at.
function localDayBounds(runDate: string): [string, string] {
  const [y, m, d] = runDate.split('-').map(Number);
  return [
    new Date(y, m - 1, d).toISOString(),
    new Date(y, m - 1, d + 1).toISOString(),
  ];
}

export interface JournalSource {
  label: string;
  dir: string; // vault-relative folder the source writes its notes into
  taskId: string; // the task whose run produces the note
  kind: 'soul' | 'task';
}

export function listJournalSources(
  db: Database.Database,
  mainFolder: string,
  config: JournalConfig,
): JournalSource[] {
  const productionTask = `soul-production-${mainFolder}`;
  const souls = db
    .prepare(
      `SELECT folder FROM souls
        WHERE state = 'active' AND folder != ? ORDER BY folder`,
    )
    .all(mainFolder) as { folder: string }[];
  const sources: JournalSource[] = [
    mainFolder,
    ...souls.map((s) => s.folder),
  ].map((folder) => ({
    label: folder,
    dir: `${JOURNAL_DIR}/Souls/${folder}`,
    taskId: productionTask,
    kind: 'soul' as const,
  }));
  for (const [taskId, name] of Object.entries(config.tasks)) {
    const task = db
      .prepare('SELECT status FROM scheduled_tasks WHERE id = ?')
      .get(taskId) as { status: string } | undefined;
    // A paused or deleted task isn't expected to run, so don't wait for it.
    if (task?.status !== 'active') continue;
    sources.push({
      label: name,
      dir: `${JOURNAL_DIR}/Tasks/${name}`,
      taskId,
      kind: 'task',
    });
  }
  return sources;
}

export type SourceOutcome =
  | {
      source: JournalSource;
      state: 'written';
      flags: number | null;
      summary: string;
    }
  | { source: JournalSource; state: 'not-finished'; reason: string };

interface RunRow {
  status: string;
  result: string | null;
  error: string | null;
}

function latestRunOn(
  db: Database.Database,
  taskId: string,
  runDate: string,
): RunRow | undefined {
  const [start, end] = localDayBounds(runDate);
  return db
    .prepare(
      `SELECT status, result, error FROM task_run_logs
        WHERE task_id = ? AND run_at >= ? AND run_at < ?
        ORDER BY run_at DESC, id DESC LIMIT 1`,
    )
    .get(taskId, start, end) as RunRow | undefined;
}

function readFrontmatter(markdown: string): Record<string, unknown> | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(markdown);
  if (!match) return null;
  try {
    const parsed = parseYaml(match[1]) as unknown;
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function collectOutcomes(
  db: Database.Database,
  vaultPath: string,
  sources: JournalSource[],
  runDate: string,
): SourceOutcome[] {
  return sources.map((source): SourceOutcome => {
    const notePath = path.join(vaultPath, source.dir, `${runDate}.md`);
    if (fs.existsSync(notePath)) {
      const fm = readFrontmatter(fs.readFileSync(notePath, 'utf-8')) ?? {};
      const flags =
        Number.isInteger(fm.flags) && (fm.flags as number) >= 0
          ? (fm.flags as number)
          : null;
      const summary =
        typeof fm.summary === 'string' && fm.summary.trim() !== ''
          ? fm.summary.trim()
          : '(no summary)';
      return { source, state: 'written', flags, summary };
    }
    const run = latestRunOn(db, source.taskId, runDate);
    let reason: string;
    if (!run) reason = 'did not run';
    else if (run.status === 'timed_out') reason = 'timed out';
    else if (run.status === 'error')
      reason = `failed: ${(run.error ?? 'unknown error').slice(0, 60)}`;
    else if (run.result?.startsWith('skipped:')) reason = 'skipped';
    else reason = 'no write-up';
    return { source, state: 'not-finished', reason };
  });
}

// SQLite datetime('now') is UTC without a zone; ISO strings carry their own.
function parseStoredTime(value: string): Date {
  return new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
}

// One group_folder per bet created on runDate (retracted ones excluded).
export function betsProposedOn(
  db: Database.Database,
  runDate: string,
): string[] {
  const rows = db
    .prepare(
      `SELECT group_folder, created_at FROM bets
        WHERE status != 'retracted' ORDER BY created_at`,
    )
    .all() as { group_folder: string; created_at: string }[];
  return rows
    .filter((r) => localDateString(parseStoredTime(r.created_at)) === runDate)
    .map((r) => r.group_folder);
}

function betsLine(betFolders: string[]): string {
  return `Bets proposed: ${betFolders.length} (${[...new Set(betFolders)].join(', ')})`;
}

function isQuiet(o: SourceOutcome): boolean {
  return o.state === 'written' && o.flags === 0;
}

export function renderWeeklyIndex(
  runDate: string,
  outcomes: SourceOutcome[],
  betFolders: string[],
): string {
  const line = (o: SourceOutcome) =>
    o.state === 'written'
      ? `- [[${o.source.dir}/${runDate}|${o.source.label}]] — ${o.summary}`
      : `- ${o.source.label} — not finished (${o.reason})`;
  const parts = [
    `---\ntype: research-journal-index\nrun: ${runDate}\n---\n# Monday research — ${runDate}`,
  ];
  for (const [heading, kind] of [
    ['Souls', 'soul'],
    ['Tasks', 'task'],
  ] as const) {
    const group = outcomes.filter((o) => o.source.kind === kind);
    if (group.length > 0) {
      parts.push(`## ${heading}\n${group.map(line).join('\n')}`);
    }
  }
  if (betFolders.length > 0) parts.push(betsLine(betFolders));
  return `${parts.join('\n\n')}\n`;
}

// Null when there is nothing to tell the owner: every source wrote a quiet
// note and no bet was proposed.
export function renderDigest(
  runDate: string,
  outcomes: SourceOutcome[],
  betFolders: string[],
): string | null {
  const flagged = outcomes.filter((o) => o.state === 'written' && !isQuiet(o));
  const unfinished = outcomes.filter((o) => o.state === 'not-finished');
  const quiet = outcomes.filter(isQuiet);
  if (
    flagged.length === 0 &&
    unfinished.length === 0 &&
    betFolders.length === 0
  )
    return null;

  const [, month, day] = runDate.split('-').map(Number);
  const lines = [`Monday research — ${MONTHS[month - 1]} ${day}`];
  for (const o of flagged) {
    if (o.state !== 'written') continue;
    const summary =
      o.summary.length > DIGEST_SUMMARY_MAX
        ? `${o.summary.slice(0, DIGEST_SUMMARY_MAX - 1)}…`
        : o.summary;
    lines.push(`• ${o.source.label}: ${summary}`);
  }
  if (betFolders.length > 0) lines.push(`• ${betsLine(betFolders)}`);
  if (unfinished.length > 0) {
    const list = unfinished.map((o) =>
      o.state === 'not-finished' ? `${o.source.label} (${o.reason})` : '',
    );
    lines.push(`• Not finished: ${list.join(', ')}`);
  }
  if (quiet.length > 0) {
    lines.push(`• Quiet: ${quiet.map((o) => o.source.label).join(', ')}`);
  }
  lines.push(`Full write-ups → ${JOURNAL_DIR}/${runDate} Weekly`);
  return lines.join('\n');
}

export interface DigestDeps {
  db: Database.Database;
  vaultPath: string;
  soulDir: string;
  config: JournalConfig;
  mainFolder: string;
  now: Date;
  send: (text: string) => Promise<unknown>;
}

function readLastDone(soulDir: string): string | null {
  try {
    const state = JSON.parse(
      fs.readFileSync(path.join(soulDir, DIGEST_STATE_FILE), 'utf-8'),
    ) as { lastDone?: unknown };
    return typeof state.lastDone === 'string' ? state.lastDone : null;
  } catch {
    return null;
  }
}

// One pass of the Monday digest. Waits until every source's task has run
// today (or the deadline), writes the weekly index once, then sends at most
// one digest. A failed send throws and leaves the day open, so the next tick
// retries without rewriting the index.
export async function runResearchDigest(
  deps: DigestDeps,
): Promise<'already-done' | 'not-ready' | 'sent' | 'quiet'> {
  const { db, vaultPath, soulDir, config, mainFolder, now } = deps;
  const runDate = localDateString(now);
  if (readLastDone(soulDir) === runDate) return 'already-done';

  const sources = listJournalSources(db, mainFolder, config);
  const finished = [...new Set(sources.map((s) => s.taskId))].every(
    (taskId) => latestRunOn(db, taskId, runDate) !== undefined,
  );
  if (!finished && now.getHours() < DIGEST_DEADLINE_HOUR) return 'not-ready';

  const outcomes = collectOutcomes(db, vaultPath, sources, runDate);
  const bets = betsProposedOn(db, runDate);
  const indexPath = path.join(vaultPath, JOURNAL_DIR, `${runDate} Weekly.md`);
  if (!fs.existsSync(indexPath)) {
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.writeFileSync(
      indexPath,
      renderWeeklyIndex(runDate, outcomes, bets),
      'utf-8',
    );
  }

  const text = renderDigest(runDate, outcomes, bets);
  if (text) await deps.send(text);

  fs.mkdirSync(soulDir, { recursive: true });
  fs.writeFileSync(
    path.join(soulDir, DIGEST_STATE_FILE),
    JSON.stringify({ lastDone: runDate }),
    'utf-8',
  );
  return text ? 'sent' : 'quiet';
}
