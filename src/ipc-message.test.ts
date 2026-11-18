import fs from 'fs';
import path from 'path';

import { expect, it, vi } from 'vitest';

const { dataDir } = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  return { dataDir: mkdtempSync(join(tmpdir(), 'nanoclaw-ipc-')) };
});

vi.mock('./config.js', async (orig) => ({
  ...(await orig<typeof import('./config.js')>()),
  DATA_DIR: dataDir,
}));

import { startIpcWatcher } from './ipc.js';

it('strips <internal> from send_message text and drops all-internal messages', async () => {
  const messagesDir = path.join(dataDir, 'ipc', 'main', 'messages');
  fs.mkdirSync(messagesDir, { recursive: true });
  const write = (name: string, text: string) =>
    fs.writeFileSync(
      path.join(messagesDir, name),
      JSON.stringify({ type: 'message', chatJid: 'main@g.us', text }),
    );
  write('1.json', '<internal>step notes</internal>Bet is live.');
  write('2.json', '<internal>only notes</internal>');

  const sendMessage = vi.fn(async () => null);
  startIpcWatcher({
    sendMessage,
    registeredGroups: () => ({}),
    registerGroup: () => {},
    syncGroupMetadata: async () => {},
    getAvailableGroups: () => [],
    writeGroupsSnapshot: () => {},
  });

  await vi.waitFor(() => expect(fs.readdirSync(messagesDir)).toEqual([]));
  expect(sendMessage).toHaveBeenCalledTimes(1);
  expect(sendMessage).toHaveBeenCalledWith('main@g.us', 'Bet is live.', {
    buttons: undefined,
    silent: undefined,
  });
  fs.rmSync(dataDir, { recursive: true, force: true });
});
