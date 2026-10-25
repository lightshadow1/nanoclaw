// Research journal: the host side of the owner's Obsidian vault.
//
// Containers write the journal notes (see research-journal-prompts.ts); the
// host only reads them. It finds owner comments that still need a reply, so
// the curation pass can be woken for them, and it builds the Monday weekly
// index and the single Telegram digest once every research run has finished.

import fs from 'fs';
import path from 'path';

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
