import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

export const MAX_TASK_SKILLS = 8;
export const MAX_SKILLS_JSON_BYTES = 2048;
export const MAX_SKILL_FILES = 128;
export const MAX_SKILL_FILE_BYTES = 1024 * 1024;
export const MAX_SKILL_TOTAL_BYTES = 2 * 1024 * 1024;
export const MAX_SKILL_DEPTH = 8;

const SKILL_NAME = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const INCLUDED_ROOTS = new Set(['references', 'templates', 'scripts']);
const EXCLUDED_NAMES = new Set(['.DS_Store', '.git', '.hg', '.svn']);

export interface InstalledSkill {
  name: string;
  description: string | null;
  contentHash: string;
  relativeFiles: string[];
}

export interface ResolvedSkillBinding {
  name: string;
  contentHash: string;
}

export function validateSkillNames(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((name) => typeof name !== 'string')) {
    throw new Error('Task skills must be an array of skill names');
  }
  const names = value as string[];
  if (names.length > MAX_TASK_SKILLS) {
    throw new Error(`Task may bind at most ${MAX_TASK_SKILLS} skills`);
  }
  for (const name of names) {
    if (!SKILL_NAME.test(name)) throw new Error(`Invalid skill name: ${name}`);
  }
  if (new Set(names).size !== names.length) {
    throw new Error('Task skill bindings must not contain duplicates');
  }
  if (Buffer.byteLength(JSON.stringify(names)) > MAX_SKILLS_JSON_BYTES) {
    throw new Error('Task skill bindings exceed the 2 KiB limit');
  }
  return [...names];
}

export function parseStoredSkillNames(value: unknown): string[] {
  if (typeof value !== 'string')
    throw new Error('Stored task skills are not JSON');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Stored task skills contain malformed JSON');
  }
  return validateSkillNames(parsed);
}

function descriptionFromSkillMd(bytes: Buffer): string | null {
  const match = bytes
    .toString('utf8')
    .match(/^---\r?\n[\s\S]*?^description:\s*(.+?)\s*$[\s\S]*?^---\s*$/m);
  return match?.[1]?.replace(/^['"]|['"]$/g, '') ?? null;
}

function selectedFiles(skillDir: string): string[] {
  const files = ['SKILL.md'];
  const walk = (absoluteDir: string, relativeDir: string, depth: number) => {
    if (depth > MAX_SKILL_DEPTH)
      throw new Error('Skill directory exceeds depth limit');
    const entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
    for (const entry of entries) {
      if (EXCLUDED_NAMES.has(entry.name) || entry.name.endsWith('.log'))
        continue;
      const relative = path.posix.join(relativeDir, entry.name);
      const absolute = path.join(absoluteDir, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink())
        throw new Error(`Skill contains a symlink: ${relative}`);
      if (stat.isDirectory()) walk(absolute, relative, depth + 1);
      else if (stat.isFile()) files.push(relative);
    }
  };
  for (const root of [...INCLUDED_ROOTS].sort()) {
    const absolute = path.join(skillDir, root);
    if (!fs.existsSync(absolute)) continue;
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink())
      throw new Error(`Skill contains a symlink: ${root}`);
    if (!stat.isDirectory())
      throw new Error(`Skill support path is not a directory: ${root}`);
    walk(absolute, root, 1);
  }
  return files.sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
}

export function readInstalledSkill(
  skillRoot: string,
  name: string,
): InstalledSkill {
  validateSkillNames([name]);
  const root = fs.realpathSync(skillRoot);
  const skillDir = path.join(root, name);
  const dirStat = fs.lstatSync(skillDir);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new Error(`Installed skill is not a directory: ${name}`);
  }
  const resolvedDir = fs.realpathSync(skillDir);
  if (path.dirname(resolvedDir) !== root)
    throw new Error(`Installed skill escapes catalog: ${name}`);
  const skillMd = path.join(resolvedDir, 'SKILL.md');
  if (!fs.existsSync(skillMd) || !fs.lstatSync(skillMd).isFile()) {
    throw new Error(`Installed skill is missing SKILL.md: ${name}`);
  }

  const relativeFiles = selectedFiles(resolvedDir);
  if (relativeFiles.length > MAX_SKILL_FILES)
    throw new Error(`Installed skill has too many files: ${name}`);
  const hash = createHash('sha256');
  let totalBytes = 0;
  let skillMdBytes: Buffer | null = null;
  for (const relative of relativeFiles) {
    const bytes = fs.readFileSync(path.join(resolvedDir, relative));
    if (bytes.length > MAX_SKILL_FILE_BYTES)
      throw new Error(`Installed skill file is too large: ${name}`);
    totalBytes += bytes.length;
    if (totalBytes > MAX_SKILL_TOTAL_BYTES)
      throw new Error(`Installed skill is too large: ${name}`);
    const pathBytes = Buffer.from(relative, 'utf8');
    const frame = Buffer.allocUnsafe(8);
    frame.writeUInt32BE(pathBytes.length, 0);
    frame.writeUInt32BE(bytes.length, 4);
    hash.update(frame).update(pathBytes).update(bytes);
    if (relative === 'SKILL.md') skillMdBytes = bytes;
  }
  return {
    name,
    description: descriptionFromSkillMd(skillMdBytes!),
    contentHash: hash.digest('hex'),
    relativeFiles,
  };
}

export function resolveSkillBindings(
  names: unknown,
  skillRoot = path.join(process.cwd(), 'container', 'skills'),
): ResolvedSkillBinding[] {
  return validateSkillNames(names).map((name) => {
    let skill: InstalledSkill;
    try {
      skill = readInstalledSkill(skillRoot, name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Installed skill not found: ${name}`);
      }
      throw error;
    }
    return { name: skill.name, contentHash: skill.contentHash };
  });
}

export function listInstalledSkills(
  skillRoot = path.join(process.cwd(), 'container', 'skills'),
): InstalledSkill[] {
  const root = fs.realpathSync(skillRoot);
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.'))
    .sort((a, b) => Buffer.from(a.name).compare(Buffer.from(b.name)))
    .map((entry) => {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error(`Invalid installed skill catalog entry: ${entry.name}`);
      }
      return readInstalledSkill(root, entry.name);
    });
}
