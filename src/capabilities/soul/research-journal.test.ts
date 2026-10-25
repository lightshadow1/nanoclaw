import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  findUnhandledComments,
  scanVaultComments,
  writeVaultCommentsFile,
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
