import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  MAX_SKILL_FILE_BYTES,
  readInstalledSkill,
  resolveSkillBindings,
  validateSkillNames,
} from './skill-catalog.js';

const roots: string[] = [];

function catalog(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-skills-'));
  roots.push(root);
  return root;
}

function addSkill(root: string, name: string, files: Record<string, string>) {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, name, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe('installed skill catalog', () => {
  it('hashes selected files in stable bytewise path order', () => {
    const first = catalog();
    const second = catalog();
    addSkill(first, 'demo', {
      'SKILL.md': '---\ndescription: Demo\n---\nInstructions',
      'scripts/z.sh': 'z',
      'references/a.md': 'a',
      'references/debug.log': 'ignored log',
      'scripts/.DS_Store': 'ignored metadata',
      'ignored.txt': 'ignored one',
    });
    addSkill(second, 'demo', {
      'ignored.txt': 'ignored two',
      'references/a.md': 'a',
      'references/debug.log': 'different ignored log',
      'scripts/.DS_Store': 'different ignored metadata',
      'scripts/z.sh': 'z',
      'SKILL.md': '---\ndescription: Demo\n---\nInstructions',
    });
    const a = readInstalledSkill(first, 'demo');
    const b = readInstalledSkill(second, 'demo');
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.relativeFiles).toEqual([
      'SKILL.md',
      'references/a.md',
      'scripts/z.sh',
    ]);
    expect(a.description).toBe('Demo');
  });

  it('changes the hash when selected content or paths change', () => {
    const root = catalog();
    addSkill(root, 'demo', { 'SKILL.md': 'body', 'scripts/a.sh': 'one' });
    const initial = readInstalledSkill(root, 'demo').contentHash;
    fs.renameSync(
      path.join(root, 'demo/scripts/a.sh'),
      path.join(root, 'demo/scripts/b.sh'),
    );
    expect(readInstalledSkill(root, 'demo').contentHash).not.toBe(initial);
    fs.writeFileSync(path.join(root, 'demo/scripts/b.sh'), 'two');
    expect(readInstalledSkill(root, 'demo').contentHash).not.toBe(initial);
  });

  it('rejects invalid bindings, missing skills, symlinks, and oversized files', () => {
    expect(() => validateSkillNames(['../escape'])).toThrow(
      'Invalid skill name',
    );
    expect(() => validateSkillNames(['demo', 'demo'])).toThrow('duplicates');
    expect(() =>
      validateSkillNames(Array.from({ length: 9 }, (_, i) => `s${i}`)),
    ).toThrow('at most 8');
    const root = catalog();
    expect(() => resolveSkillBindings(['missing'], root)).toThrow('not found');
    addSkill(root, 'linked', { 'SKILL.md': 'body', 'references/target': 'x' });
    fs.symlinkSync('target', path.join(root, 'linked/references/link'));
    expect(() => readInstalledSkill(root, 'linked')).toThrow('symlink');
    addSkill(root, 'large', {
      'SKILL.md': 'x'.repeat(MAX_SKILL_FILE_BYTES + 1),
    });
    expect(() => readInstalledSkill(root, 'large')).toThrow('too large');
  });
});
