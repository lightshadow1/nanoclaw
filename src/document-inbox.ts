import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;
const GROUP_MAX_BYTES = 200 * 1024 * 1024;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const EXTENSIONS = new Set([
  'docx',
  'xlsx',
  'pptx',
  'odt',
  'ods',
  'odp',
  'rtf',
  'epub',
  'csv',
  'txt',
  'pdf',
]);
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');

// Outside the project: even the main agent's project mount cannot modify this.
export function documentInboxRoot(): string {
  return path.join(
    os.homedir(),
    '.local',
    'share',
    'nanoclaw-documents',
    digest(process.cwd()).slice(0, 16),
  );
}

export function documentInboxPath(
  group: string,
  root = documentInboxRoot(),
): string {
  return path.join(root, digest(group));
}

function ensureDirectory(directory: string): void {
  const parent = path.dirname(directory);
  if (parent !== directory) ensureDirectory(parent);
  try {
    fs.mkdirSync(directory, { mode: 0o755 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('Unsafe document inbox');
}

export function ensureDocumentInbox(group: string): string {
  const directory = documentInboxPath(group);
  ensureDirectory(directory);
  return directory;
}

const pending = new Map<string, Promise<string>>();

export interface DocumentDownload {
  group: string;
  identity: string;
  filename: string;
  size?: number;
  load: (signal: AbortSignal) => Promise<Response>;
  root?: string;
}

export function downloadDocument(input: DocumentDownload): Promise<string> {
  const directory = documentInboxPath(input.group, input.root);
  const key = `${directory}:${input.identity}`;
  const duplicate = pending.get(key);
  if (duplicate) return duplicate;
  // Bound memory, sockets and concurrent quota reservations. One download per group.
  if (
    pending.size >= 4 ||
    [...pending.keys()].some((k) => k.startsWith(`${directory}:`))
  ) {
    return Promise.reject(
      new Error('Document download busy; please resend shortly'),
    );
  }
  const promise = receiveDocument(input, directory).finally(() =>
    pending.delete(key),
  );
  pending.set(key, promise);
  return promise;
}

async function receiveDocument(
  input: DocumentDownload,
  directory: string,
): Promise<string> {
  const extension = path.extname(input.filename).slice(1).toLowerCase();
  if (!EXTENSIONS.has(extension))
    throw new Error('Unsupported document format');
  if (
    input.size !== undefined &&
    (!Number.isFinite(input.size) ||
      input.size < 0 ||
      input.size > DOCUMENT_MAX_BYTES)
  ) {
    throw new Error('Document exceeds the 20 MiB limit');
  }
  ensureDirectory(directory);
  const filename = `${digest(input.identity)}.${extension}`;
  const destination = path.join(directory, filename);
  let used = 0;
  for (const name of fs.readdirSync(directory)) {
    const file = path.join(directory, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw new Error('Unsafe document inbox');
    if (Date.now() - stat.mtimeMs > RETENTION_MS || name.endsWith('.partial'))
      fs.unlinkSync(file);
    else used += stat.size;
  }
  if (fs.existsSync(destination)) return `/workspace/inbox/${filename}`;
  if (used + (input.size ?? DOCUMENT_MAX_BYTES) > GROUP_MAX_BYTES) {
    throw new Error(
      'Document inbox is full; retained files expire after seven days',
    );
  }
  const temporary = path.join(directory, `${randomUUID()}.partial`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let fd: number | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await input.load(controller.signal);
    if (!response.ok || !response.body) throw new Error('Download failed');
    reader = response.body.getReader();
    fd = fs.openSync(temporary, 'wx', 0o600);
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > DOCUMENT_MAX_BYTES || used + received > GROUP_MAX_BYTES)
        throw new Error('Download too large');
      fs.writeFileSync(fd, value);
    }
    if (!received || (input.size !== undefined && received !== input.size))
      throw new Error('Incomplete document');
    fs.fchmodSync(fd, 0o444);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, destination);
    return `/workspace/inbox/${filename}`;
  } catch {
    // Network exceptions can include Telegram's token-bearing URL. Never expose them.
    throw new Error(
      'Document download failed (size limit, timeout, or network error); please resend',
    );
  } finally {
    clearTimeout(timer);
    controller.abort();
    await reader?.cancel().catch(() => {});
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
