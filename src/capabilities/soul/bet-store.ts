// Phase 6 host-side bet store. Deterministic plumbing only — bets are
// CREATED by the main container (sqlite3 INSERT in the production-pass
// prompt) and the language judgment lives there; the host publishes,
// resolves from ground-truth interaction events, expires on timeout, and
// renders the pinned ledger.

import type Database from 'better-sqlite3';

export const BET_WINDOW_DAYS = 7;
// Max bets that may be 'proposed' or 'sent' at once, across all souls.
// Frequency discipline lives here, not in prompt exhortations.
export const MAX_OPEN_BETS = 3;

export type BetStatus = 'proposed' | 'sent' | 'resolved' | 'expired' | 'retracted';
export type BetResolution =
  | 'acted'
  | 'deferred'
  | 'rejected'
  | 'referenced'
  | 'expired';
export type BetResolutionSource = 'button' | 'reaction' | 'reference' | 'timeout';

export interface Bet {
  id: string;
  groupFolder: string;
  title: string;
  body: string;
  recommendation: string | null;
  prediction: string | null;
  status: BetStatus;
  createdAt: string;
  sentAt: string | null;
  channelMessageId: string | null;
  windowDays: number;
  resolution: BetResolution | null;
  resolutionSource: BetResolutionSource | null;
  resolvedAt: string | null;
}

interface BetRow {
  id: string;
  group_folder: string;
  title: string;
  body: string;
  recommendation: string | null;
  prediction: string | null;
  status: BetStatus;
  created_at: string;
  sent_at: string | null;
  channel_message_id: string | null;
  window_days: number;
  resolution: BetResolution | null;
  resolution_source: BetResolutionSource | null;
  resolved_at: string | null;
}

const SELECT_COLS = `id, group_folder, title, body, recommendation, prediction,
  status, created_at, sent_at, channel_message_id, window_days,
  resolution, resolution_source, resolved_at`;

function rowToBet(r: BetRow): Bet {
  return {
    id: r.id,
    groupFolder: r.group_folder,
    title: r.title,
    body: r.body,
    recommendation: r.recommendation,
    prediction: r.prediction,
    status: r.status,
    createdAt: r.created_at,
    sentAt: r.sent_at,
    channelMessageId: r.channel_message_id,
    windowDays: r.window_days,
    resolution: r.resolution,
    resolutionSource: r.resolution_source,
    resolvedAt: r.resolved_at,
  };
}

export function getBetById(db: Database.Database, id: string): Bet | null {
  const row = db
    .prepare(`SELECT ${SELECT_COLS} FROM bets WHERE id = ?`)
    .get(id) as BetRow | undefined;
  return row ? rowToBet(row) : null;
}

// 'proposed' + 'sent' — everything that counts against MAX_OPEN_BETS.
export function getOpenBets(db: Database.Database): Bet[] {
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM bets
        WHERE status IN ('proposed', 'sent')
        ORDER BY created_at ASC`,
    )
    .all() as BetRow[];
  return rows.map(rowToBet);
}

export function getRecentResolvedBets(
  db: Database.Database,
  limit = 5,
): Bet[] {
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM bets
        WHERE status IN ('resolved', 'expired')
        ORDER BY resolved_at DESC
        LIMIT ?`,
    )
    .all(limit) as BetRow[];
  return rows.map(rowToBet);
}

// Stamp a proposed bet as sent. Returns false if the bet isn't 'proposed'
// (already sent, resolved, or unknown) so callers can refuse double-sends.
export function markBetSent(
  db: Database.Database,
  id: string,
  channelMessageId: string | null,
  now: Date = new Date(),
): boolean {
  const res = db
    .prepare(
      `UPDATE bets
          SET status = 'sent', sent_at = ?, channel_message_id = ?
        WHERE id = ? AND status = 'proposed'`,
    )
    .run(now.toISOString(), channelMessageId, id);
  return res.changes > 0;
}

// Ground-truth resolution from a button tap or reaction on the bet's
// channel message. Only 'sent' bets resolve; later interactions on an
// already-resolved bet are ignored (first signal wins).
export function resolveBetByMessageId(
  db: Database.Database,
  channelMessageId: string,
  resolution: BetResolution,
  source: BetResolutionSource,
  now: Date = new Date(),
): Bet | null {
  const row = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM bets
        WHERE channel_message_id = ? AND status = 'sent'`,
    )
    .get(channelMessageId) as BetRow | undefined;
  if (!row) return null;
  db.prepare(
    `UPDATE bets
        SET status = 'resolved', resolution = ?, resolution_source = ?,
            resolved_at = ?
      WHERE id = ?`,
  ).run(resolution, source, now.toISOString(), row.id);
  return getBetById(db, row.id);
}

export function resolveBetById(
  db: Database.Database,
  id: string,
  resolution: BetResolution,
  source: BetResolutionSource,
  now: Date = new Date(),
): boolean {
  const res = db
    .prepare(
      `UPDATE bets
          SET status = 'resolved', resolution = ?, resolution_source = ?,
              resolved_at = ?
        WHERE id = ? AND status = 'sent'`,
    )
    .run(resolution, source, now.toISOString(), id);
  return res.changes > 0;
}

// Timeout: 'sent' bets past their window expire. Deterministic — runs
// host-side in the check-in gate, no container needed. "No response in a
// week" is itself a label (the noise baseline at work), not an error.
export function expireOverdueBets(
  db: Database.Database,
  now: Date = new Date(),
): number {
  const res = db
    .prepare(
      `UPDATE bets
          SET status = 'expired', resolution = 'expired',
              resolution_source = 'timeout', resolved_at = ?
        WHERE status = 'sent'
          AND datetime(sent_at, '+' || window_days || ' days') <= datetime(?)`,
    )
    .run(now.toISOString(), now.toISOString());
  return res.changes;
}

const RESOLUTION_ICONS: Record<BetResolution, string> = {
  acted: '✅',
  deferred: '⏸',
  rejected: '❌',
  referenced: '💬',
  expired: '⏳',
};

function daysLeft(bet: Bet, now: Date): number {
  if (!bet.sentAt) return bet.windowDays;
  const deadline =
    new Date(bet.sentAt).getTime() + bet.windowDays * 24 * 60 * 60 * 1000;
  return Math.max(0, Math.ceil((deadline - now.getTime()) / (24 * 60 * 60 * 1000)));
}

// Host-rendered content for the pinned ledger message. Deterministic so the
// ledger never depends on a container run to stay current.
export function renderLedger(
  db: Database.Database,
  now: Date = new Date(),
): string {
  const open = getOpenBets(db);
  const sent = open.filter((b) => b.status === 'sent');
  const proposed = open.filter((b) => b.status === 'proposed');
  const recent = getRecentResolvedBets(db, 5);

  const lines: string[] = ['📒 Bet Ledger'];

  if (sent.length > 0) {
    lines.push('', 'Awaiting your call:');
    for (const b of sent) {
      lines.push(`• ${b.title} (${b.groupFolder}) — ${daysLeft(b, now)}d left`);
    }
  }
  if (proposed.length > 0) {
    lines.push('', 'Queued:');
    for (const b of proposed) {
      lines.push(`• ${b.title} (${b.groupFolder})`);
    }
  }
  if (recent.length > 0) {
    lines.push('', 'Recently resolved:');
    for (const b of recent) {
      const icon = b.resolution ? RESOLUTION_ICONS[b.resolution] : '·';
      lines.push(`${icon} ${b.title} (${b.resolution ?? 'unknown'})`);
    }
  }
  if (sent.length === 0 && proposed.length === 0 && recent.length === 0) {
    lines.push('', 'No open bets. Souls are accumulating quietly.');
  }

  lines.push(
    '',
    `Updated ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
  );
  return lines.join('\n');
}

// The outbound message for a published bet, plus its one-tap buttons.
export function formatBetMessage(bet: Bet): {
  text: string;
  buttons: { id: string; label: string }[][];
} {
  const parts = [`🎯 ${bet.title}`, '', bet.body];
  if (bet.recommendation) {
    parts.push('', `Recommendation: ${bet.recommendation}`);
  }
  return {
    text: parts.join('\n'),
    buttons: [
      [
        { id: `bet:${bet.id}:acted`, label: '✅ Act on it' },
        { id: `bet:${bet.id}:deferred`, label: '⏸ Later' },
        { id: `bet:${bet.id}:rejected`, label: '❌ Not useful' },
      ],
    ],
  };
}

// Parse a `bet:<id>:<resolution>` button id. Returns null for anything else.
export function parseBetButton(
  data: string,
): { betId: string; resolution: BetResolution } | null {
  const m = /^bet:(.+):(acted|deferred|rejected)$/.exec(data);
  if (!m) return null;
  return { betId: m[1], resolution: m[2] as BetResolution };
}
