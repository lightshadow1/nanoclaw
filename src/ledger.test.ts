import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Channel } from './types.js';

// Point DATA_DIR at a temp dir before importing the module under test.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-ledger-'));
vi.mock('./config.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./config.js')>();
  return { ...orig, DATA_DIR: tmpDir };
});

const { setLedger } = await import('./ledger.js');

function mockChannel(overrides?: Partial<Channel>): Channel {
  return {
    name: 'mock',
    connect: async () => {},
    sendMessage: vi.fn().mockResolvedValue('101'),
    isConnected: () => true,
    ownsJid: () => true,
    disconnect: async () => {},
    editMessage: vi.fn().mockResolvedValue(undefined),
    pinMessage: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const statePath = (folder: string) =>
  path.join(tmpDir, 'ledger', `${folder}.json`);

describe('setLedger', () => {
  beforeEach(() => {
    fs.rmSync(path.join(tmpDir, 'ledger'), { recursive: true, force: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('first call sends silently, pins, and records the message id', async () => {
    const ch = mockChannel();
    await setLedger(ch, 'tg:123', 'main', 'ledger v1');

    expect(ch.sendMessage).toHaveBeenCalledWith('tg:123', 'ledger v1', {
      silent: true,
    });
    expect(ch.pinMessage).toHaveBeenCalledWith('tg:123', '101');
    expect(JSON.parse(fs.readFileSync(statePath('main'), 'utf-8'))).toEqual({
      chatJid: 'tg:123',
      messageId: '101',
    });
  });

  it('subsequent calls edit the tracked message in place', async () => {
    const ch = mockChannel();
    await setLedger(ch, 'tg:123', 'main', 'ledger v1');
    await setLedger(ch, 'tg:123', 'main', 'ledger v2');

    expect(ch.editMessage).toHaveBeenCalledWith('tg:123', '101', 'ledger v2');
    expect(ch.sendMessage).toHaveBeenCalledTimes(1); // only the initial send
  });

  it('recreates the message when the edit fails', async () => {
    const ch = mockChannel();
    await setLedger(ch, 'tg:123', 'main', 'v1');

    (ch.editMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('message to edit not found'),
    );
    (ch.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValueOnce('202');
    await setLedger(ch, 'tg:123', 'main', 'v2');

    expect(ch.sendMessage).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fs.readFileSync(statePath('main'), 'utf-8'))).toEqual({
      chatJid: 'tg:123',
      messageId: '202',
    });
  });

  it('treats "message is not modified" as success, not recreation', async () => {
    const ch = mockChannel();
    await setLedger(ch, 'tg:123', 'main', 'same');

    (ch.editMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('400: Bad Request: message is not modified'),
    );
    await setLedger(ch, 'tg:123', 'main', 'same');

    expect(ch.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('survives a channel without pin support', async () => {
    const ch = mockChannel({ pinMessage: undefined });
    await setLedger(ch, 'tg:123', 'main', 'v1');
    expect(fs.existsSync(statePath('main'))).toBe(true);
  });

  it('does not track when the channel returns no message id', async () => {
    const ch = mockChannel({
      sendMessage: vi.fn().mockResolvedValue(null),
    });
    await setLedger(ch, 'tg:123', 'main', 'v1');
    expect(fs.existsSync(statePath('main'))).toBe(false);
  });
});
