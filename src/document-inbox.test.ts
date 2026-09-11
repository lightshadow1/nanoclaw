import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DOCUMENT_MAX_BYTES,
  documentInboxPath,
  downloadDocument,
} from './document-inbox.js';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'document-inbox-'),
  );
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});
const input = () => ({
  root,
  group: 'research',
  identity: 'chat:1:file',
  filename: "../report $(touch oops) 'Q3'.pdf",
  size: 4,
  load: vi.fn(async () => new Response('text')),
});

describe('document inbox', () => {
  it('uses generated names, read-only files and distinct group namespaces; reuses duplicates', async () => {
    const request = input();
    const local = await downloadDocument(request);
    expect(local).toMatch(/^\/workspace\/inbox\/[a-f0-9]{64}\.pdf$/);
    const disk = path.join(
      documentInboxPath('research', root),
      path.basename(local),
    );
    expect(fs.readFileSync(disk, 'utf8')).toBe('text');
    expect(fs.statSync(disk).mode & 0o222).toBe(0);
    expect(await downloadDocument(request)).toBe(local);
    expect(request.load).toHaveBeenCalledTimes(1);
    await downloadDocument({ ...request, group: 'other' });
    expect(documentInboxPath('other', root)).not.toBe(path.dirname(disk));
    expect(request.load).toHaveBeenCalledTimes(2);
  });
  it('rejects oversized metadata and unsupported formats without fetching', async () => {
    const request = input();
    await expect(
      downloadDocument({ ...request, size: DOCUMENT_MAX_BYTES + 1 }),
    ).rejects.toThrow('20 MiB');
    await expect(
      downloadDocument({ ...request, filename: 'payload.exe' }),
    ).rejects.toThrow('Unsupported');
    expect(request.load).not.toHaveBeenCalled();
  });
  it('bounds streaming bytes and removes partial downloads', async () => {
    await expect(
      downloadDocument({
        ...input(),
        size: undefined,
        load: async () => new Response(new Uint8Array(DOCUMENT_MAX_BYTES + 1)),
      }),
    ).rejects.toThrow('download failed');
    expect(fs.readdirSync(documentInboxPath('research', root))).toEqual([]);
  });
  it('rejects truncated downloads and never returns a local path', async () => {
    await expect(downloadDocument({ ...input(), size: 5 })).rejects.toThrow(
      'download failed',
    );
    expect(fs.readdirSync(documentInboxPath('research', root))).toEqual([]);
  });
  it('rejects symlinked group roots and files', async () => {
    const outside = fs.mkdtempSync(path.join(root, 'outside-'));
    fs.symlinkSync(outside, documentInboxPath('research', root));
    await expect(downloadDocument(input())).rejects.toThrow('Unsafe');
    fs.unlinkSync(documentInboxPath('research', root));
    fs.mkdirSync(documentInboxPath('research', root));
    fs.writeFileSync(path.join(outside, 'file'), 'secret');
    fs.symlinkSync(
      path.join(outside, 'file'),
      path.join(documentInboxPath('research', root), 'evil.pdf'),
    );
    await expect(downloadDocument(input())).rejects.toThrow('Unsafe');
    expect(fs.readFileSync(path.join(outside, 'file'), 'utf8')).toBe('secret');
  });
  it('expires old downloads and rejects a full inbox', async () => {
    const dir = documentInboxPath('research', root);
    fs.mkdirSync(dir);
    const old = path.join(dir, 'old.pdf');
    fs.writeFileSync(old, 'old');
    fs.utimesSync(old, 0, 0);
    await downloadDocument(input());
    expect(fs.existsSync(old)).toBe(false);
    const quota = path.join(dir, 'large.pdf');
    fs.closeSync(fs.openSync(quota, 'w'));
    fs.truncateSync(quota, 200 * 1024 * 1024);
    await expect(
      downloadDocument({ ...input(), identity: 'new' }),
    ).rejects.toThrow('full');
  });
  it('deduplicates concurrent updates and aborts on deadline without leaking URLs', async () => {
    vi.useFakeTimers();
    const request = {
      ...input(),
      load: vi.fn(
        (signal: AbortSignal) =>
          new Promise<Response>((_resolve, reject) => {
            signal.addEventListener('abort', () =>
              reject(new Error('https://api.telegram.org/file/botSECRET/file')),
            );
          }),
      ),
    };
    const first = downloadDocument(request);
    expect(downloadDocument(request)).toBe(first);
    const result = expect(first).rejects.toThrow(
      'Document download failed (size limit, timeout, or network error); please resend',
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await result;
    expect(request.load).toHaveBeenCalledTimes(1);
  });
});
