// Pinned-ledger maintenance. Each group can keep ONE pinned, bot-edited
// message in its chat as an ambient "pull surface" — browsable state that
// never notifies. The channel message id persists in data/ledger/{folder}.json
// so restarts keep editing the same message instead of spawning new pins.

import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import { Channel } from './types.js';

interface LedgerState {
  chatJid: string;
  messageId: string;
}

function ledgerStatePath(folder: string): string {
  return path.join(DATA_DIR, 'ledger', `${folder}.json`);
}

function readLedgerState(folder: string): LedgerState | null {
  try {
    const raw = fs.readFileSync(ledgerStatePath(folder), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<LedgerState>;
    if (parsed.chatJid && parsed.messageId) {
      return { chatJid: parsed.chatJid, messageId: parsed.messageId };
    }
  } catch {
    // missing or malformed — treated as "no ledger yet"
  }
  return null;
}

function writeLedgerState(folder: string, state: LedgerState): void {
  const p = ledgerStatePath(folder);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state, null, 2), 'utf-8');
}

// Create-or-edit the group's pinned ledger message. Edits in place when a
// tracked message exists; otherwise (first run, deleted message, chat moved)
// sends silently, pins, and records the new id.
export async function setLedger(
  channel: Channel,
  chatJid: string,
  folder: string,
  text: string,
): Promise<void> {
  const existing = readLedgerState(folder);

  if (existing && existing.chatJid === chatJid && channel.editMessage) {
    try {
      await channel.editMessage(chatJid, existing.messageId, text);
      return;
    } catch (err) {
      // Telegram rejects no-op edits with "message is not modified" — that
      // means the ledger is already current, not that the message is gone.
      if (err instanceof Error && /not modified/i.test(err.message)) return;
      logger.warn(
        { chatJid, folder, err },
        'Ledger edit failed; recreating pinned message',
      );
    }
  }

  const messageId = await channel.sendMessage(chatJid, text, { silent: true });
  if (!messageId) {
    logger.warn(
      { chatJid, folder },
      'Channel returned no message id; ledger cannot be tracked',
    );
    return;
  }
  writeLedgerState(folder, { chatJid, messageId });
  try {
    await channel.pinMessage?.(chatJid, messageId);
  } catch (err) {
    // Pinning needs admin rights in groups; an unpinned ledger still works.
    logger.warn({ chatJid, folder, err }, 'Failed to pin ledger message');
  }
}
