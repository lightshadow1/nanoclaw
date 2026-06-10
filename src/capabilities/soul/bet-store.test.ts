import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase, getDb } from '../../db.js';
import { runMigrations } from '../lifecycle.js';
import { soulCapability } from './index.js';
import {
  expireOverdueBets,
  formatBetMessage,
  getBetById,
  getOpenBets,
  getRecentResolvedBets,
  markBetSent,
  parseBetButton,
  renderLedger,
  resolveBetById,
  resolveBetByMessageId,
  type Bet,
} from './bet-store.js';

function insertBet(overrides?: {
  id?: string;
  groupFolder?: string;
  title?: string;
  status?: string;
  createdAt?: string;
  sentAt?: string | null;
  channelMessageId?: string | null;
  windowDays?: number;
  recommendation?: string | null;
}): string {
  const id = overrides?.id ?? `bet-${Math.random().toString(36).slice(2, 10)}`;
  getDb()
    .prepare(
      `INSERT INTO bets (id, group_folder, title, body, recommendation, status,
         created_at, sent_at, channel_message_id, window_days)
       VALUES (?, ?, ?, 'Body text', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      overrides?.groupFolder ?? 'observability',
      overrides?.title ?? 'Test bet',
      overrides?.recommendation ?? null,
      overrides?.status ?? 'proposed',
      overrides?.createdAt ?? new Date().toISOString(),
      overrides?.sentAt ?? null,
      overrides?.channelMessageId ?? null,
      overrides?.windowDays ?? 7,
    );
  return id;
}

beforeEach(() => {
  _initTestDatabase();
  runMigrations(getDb(), soulCapability);
});

describe('bet-store basics', () => {
  it('getBetById round-trips a row', () => {
    const id = insertBet({ title: 'Use Langfuse', recommendation: 'Do it' });
    const bet = getBetById(getDb(), id)!;
    expect(bet.title).toBe('Use Langfuse');
    expect(bet.recommendation).toBe('Do it');
    expect(bet.status).toBe('proposed');
    expect(bet.windowDays).toBe(7);
  });

  it('getOpenBets returns proposed and sent, oldest first', () => {
    insertBet({ id: 'b2', createdAt: '2026-06-02T00:00:00Z' });
    insertBet({
      id: 'b1',
      status: 'sent',
      createdAt: '2026-06-01T00:00:00Z',
      sentAt: '2026-06-05T00:00:00Z',
    });
    insertBet({ id: 'b3', status: 'resolved' });
    insertBet({ id: 'b4', status: 'retracted' });

    const open = getOpenBets(getDb());
    expect(open.map((b) => b.id)).toEqual(['b1', 'b2']);
  });
});

describe('markBetSent', () => {
  it('stamps a proposed bet and refuses a second send', () => {
    const id = insertBet();
    expect(markBetSent(getDb(), id, '777')).toBe(true);
    const bet = getBetById(getDb(), id)!;
    expect(bet.status).toBe('sent');
    expect(bet.channelMessageId).toBe('777');
    expect(bet.sentAt).toBeTruthy();
    // Double-send refused.
    expect(markBetSent(getDb(), id, '888')).toBe(false);
  });
});

describe('resolution', () => {
  it('resolveBetById resolves only sent bets', () => {
    const proposed = insertBet();
    expect(resolveBetById(getDb(), proposed, 'acted', 'button')).toBe(false);

    const sent = insertBet({
      status: 'sent',
      sentAt: new Date().toISOString(),
    });
    expect(resolveBetById(getDb(), sent, 'acted', 'button')).toBe(true);
    const bet = getBetById(getDb(), sent)!;
    expect(bet.status).toBe('resolved');
    expect(bet.resolution).toBe('acted');
    expect(bet.resolutionSource).toBe('button');
    expect(bet.resolvedAt).toBeTruthy();

    // First signal wins.
    expect(resolveBetById(getDb(), sent, 'rejected', 'button')).toBe(false);
    expect(getBetById(getDb(), sent)!.resolution).toBe('acted');
  });

  it('resolveBetByMessageId finds the sent bet by channel message', () => {
    insertBet({
      id: 'target',
      status: 'sent',
      sentAt: new Date().toISOString(),
      channelMessageId: '555',
    });
    const resolved = resolveBetByMessageId(getDb(), '555', 'acted', 'reaction');
    expect(resolved?.id).toBe('target');
    expect(resolved?.resolution).toBe('acted');

    expect(
      resolveBetByMessageId(getDb(), '999', 'acted', 'reaction'),
    ).toBeNull();
  });
});

describe('expireOverdueBets', () => {
  it('expires sent bets past their window, leaves the rest', () => {
    const now = new Date('2026-06-10T12:00:00Z');
    const overdue = insertBet({
      status: 'sent',
      sentAt: '2026-06-01T00:00:00Z', // 9.5 days before now, window 7
    });
    const fresh = insertBet({
      status: 'sent',
      sentAt: '2026-06-08T00:00:00Z',
    });
    const proposed = insertBet();

    expect(expireOverdueBets(getDb(), now)).toBe(1);
    expect(getBetById(getDb(), overdue)!.status).toBe('expired');
    expect(getBetById(getDb(), overdue)!.resolution).toBe('expired');
    expect(getBetById(getDb(), overdue)!.resolutionSource).toBe('timeout');
    expect(getBetById(getDb(), fresh)!.status).toBe('sent');
    expect(getBetById(getDb(), proposed)!.status).toBe('proposed');
  });

  it('respects per-bet window_days', () => {
    const now = new Date('2026-06-10T12:00:00Z');
    const longWindow = insertBet({
      status: 'sent',
      sentAt: '2026-06-01T00:00:00Z',
      windowDays: 14,
    });
    expect(expireOverdueBets(getDb(), now)).toBe(0);
    expect(getBetById(getDb(), longWindow)!.status).toBe('sent');
  });
});

describe('renderLedger', () => {
  it('shows sent, queued, and recently resolved sections', () => {
    const now = new Date('2026-06-10T12:00:00Z');
    insertBet({
      title: 'Awaiting bet',
      status: 'sent',
      sentAt: '2026-06-08T00:00:00Z',
    });
    insertBet({ title: 'Queued bet' });
    const resolvedId = insertBet({
      title: 'Done bet',
      status: 'sent',
      sentAt: '2026-06-01T00:00:00Z',
    });
    resolveBetById(getDb(), resolvedId, 'acted', 'button', now);

    const text = renderLedger(getDb(), now);
    expect(text).toContain('Awaiting bet');
    expect(text).toContain('5d left');
    expect(text).toContain('Queued bet');
    expect(text).toContain('✅ Done bet (acted)');
  });

  it('renders a calm empty state', () => {
    const text = renderLedger(getDb());
    expect(text).toContain('No open bets');
  });

  it('getRecentResolvedBets caps the list', () => {
    for (let i = 0; i < 8; i++) {
      const id = insertBet({
        status: 'sent',
        sentAt: new Date().toISOString(),
      });
      resolveBetById(getDb(), id, 'acted', 'button');
    }
    expect(getRecentResolvedBets(getDb(), 5)).toHaveLength(5);
  });
});

describe('formatBetMessage / parseBetButton', () => {
  it('round-trips button ids through the parser', () => {
    const bet: Bet = {
      id: 'abc123',
      groupFolder: 'observability',
      title: 'T',
      body: 'B',
      recommendation: 'R',
      prediction: null,
      status: 'proposed',
      createdAt: '2026-06-10T00:00:00Z',
      sentAt: null,
      channelMessageId: null,
      windowDays: 7,
      resolution: null,
      resolutionSource: null,
      resolvedAt: null,
    };
    const { text, buttons } = formatBetMessage(bet);
    expect(text).toContain('🎯 T');
    expect(text).toContain('Recommendation: R');
    expect(buttons[0]).toHaveLength(3);
    for (const btn of buttons[0]) {
      expect(btn.id.length).toBeLessThanOrEqual(64);
      const parsed = parseBetButton(btn.id)!;
      expect(parsed.betId).toBe('abc123');
    }
    expect(parseBetButton(buttons[0][0].id)!.resolution).toBe('acted');
  });

  it('parseBetButton rejects non-bet payloads', () => {
    expect(parseBetButton('something-else')).toBeNull();
    expect(parseBetButton('bet:x:explode')).toBeNull();
    expect(parseBetButton('')).toBeNull();
  });

  it('sqlite3-generated ids (32 hex chars) keep button ids under 64 bytes', () => {
    const id = 'a'.repeat(32); // lower(hex(randomblob(16)))
    expect(`bet:${id}:deferred`.length).toBeLessThanOrEqual(64);
  });
});
