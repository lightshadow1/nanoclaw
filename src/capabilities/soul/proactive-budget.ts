import fs from 'fs';
import path from 'path';

/**
 * Host-side helpers for the proactive-messaging budget.
 *
 * The check-in container writes the canonical budget file; this module only
 * reads it, plus answers "can we send right now?" cheaply. The point is that
 * the `beforeTaskRun` hook can skip spinning up a check-in container entirely
 * when the budget is exhausted, quiet hours are in effect, or the minimum gap
 * since the last message hasn't elapsed.
 *
 * Defaults match PLANNING_PROMPT.md §10:
 *   - PROACTIVE_MAX_MESSAGES  = 3
 *   - PROACTIVE_MIN_GAP_MS    = 2h
 *   - PROACTIVE_QUIET_START   = 22 (10 PM, local time)
 *   - PROACTIVE_QUIET_END     = 7  (7 AM,  local time)
 *
 * Constants live here for v1 — promote to config/env if they need to vary
 * across deployments. The container-side check-in prompt repeats these same
 * thresholds; if you change them here, update curator-prompts/planning-prompts
 * too.
 */

export interface ProactiveBudget {
  date: string; // YYYY-MM-DD, local-date semantics
  messages_sent: number;
  last_message_at: string | null; // ISO timestamp, UTC
}

export const PROACTIVE_MAX_MESSAGES = 3;
export const PROACTIVE_MIN_GAP_MS = 2 * 60 * 60 * 1000;
export const PROACTIVE_QUIET_START = 22; // hour, inclusive
export const PROACTIVE_QUIET_END = 7; // hour, exclusive

// Phase 4.5 withdrawal periods (ABAB design — scoring inaction).
// One ISO week in WITHDRAWAL_CYCLE_WEEKS is a withdrawal week: the morning
// plan emits zero outreach items, the check-in skips proactive sends.
// ISO-week-derived so every component agrees with no stored state.
export const WITHDRAWAL_CYCLE_WEEKS = 8;

function todayString(now: Date): string {
  // Local-date YYYY-MM-DD — the budget rolls over by the soul's wall clock,
  // not UTC, so "max 3/day" matches the owner's lived day.
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Reads the proactive budget file. Returns a fresh budget for today if the
 * file is missing, malformed, or carries a previous day's date.
 *
 * Does not write the file — the container agent persists changes after
 * actually sending a message.
 */
export function readBudget(
  groupsDir: string,
  folder: string,
  now: Date = new Date(),
): ProactiveBudget {
  const budgetPath = path.join(
    groupsDir,
    folder,
    'soul',
    'proactive-budget.json',
  );
  const today = todayString(now);
  const fresh: ProactiveBudget = {
    date: today,
    messages_sent: 0,
    last_message_at: null,
  };

  if (!fs.existsSync(budgetPath)) return fresh;

  try {
    const raw = JSON.parse(
      fs.readFileSync(budgetPath, 'utf-8'),
    ) as Partial<ProactiveBudget>;
    if (
      typeof raw.date !== 'string' ||
      typeof raw.messages_sent !== 'number' ||
      (raw.last_message_at !== null && typeof raw.last_message_at !== 'string')
    ) {
      return fresh;
    }
    if (raw.date !== today) return fresh; // new day — reset
    return {
      date: raw.date,
      messages_sent: raw.messages_sent,
      last_message_at: raw.last_message_at,
    };
  } catch {
    return fresh;
  }
}

/**
 * Consume one unit of proactive budget after a HOST-side send (e.g.
 * publish_bet). The container-side check-in still updates the file itself
 * after its own send_message calls; the two writers never race in practice
 * because host sends happen synchronously inside IPC handling, not while a
 * check-in container is mid-run on the same item.
 */
export function recordProactiveSend(
  groupsDir: string,
  folder: string,
  now: Date = new Date(),
): void {
  const budget = readBudget(groupsDir, folder, now);
  budget.messages_sent += 1;
  budget.last_message_at = now.toISOString();
  const dir = path.join(groupsDir, folder, 'soul');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'proactive-budget.json'),
    JSON.stringify(budget, null, 2),
    'utf-8',
  );
}

/**
 * True iff the agent is allowed to send a proactive message at `now`.
 *
 * Does NOT consume budget. The container increments the counter on its own
 * after a successful send. This function is purely a gate.
 */
export function canSendProactive(
  budget: ProactiveBudget,
  now: Date = new Date(),
): boolean {
  const hour = now.getHours();

  // Quiet hours — straddles midnight, so OR not AND.
  if (hour >= PROACTIVE_QUIET_START || hour < PROACTIVE_QUIET_END) return false;

  // Daily cap.
  if (budget.messages_sent >= PROACTIVE_MAX_MESSAGES) return false;

  // Minimum gap since last message. Future timestamps (clock skew) also fail
  // this check because elapsed is negative, which is the conservative call.
  if (budget.last_message_at) {
    const last = new Date(budget.last_message_at).getTime();
    if (Number.isNaN(last)) return false; // unparseable → treat as just-sent
    const elapsed = now.getTime() - last;
    if (elapsed < PROACTIVE_MIN_GAP_MS) return false;
  }

  return true;
}

// Standard ISO 8601 week number. Weeks start Monday; week 1 contains the
// first Thursday of the year.
function isoWeekNumber(d: Date): number {
  const target = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (target.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  target.setUTCDate(target.getUTCDate() - dayNum + 3); // Thursday of target's week
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstThursdayDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(
    firstThursday.getUTCDate() - firstThursdayDayNum + 3,
  );
  return (
    1 +
    Math.round((target.getTime() - firstThursday.getTime()) / (7 * 86400000))
  );
}

// True during a withdrawal week. Deterministic from the ISO week number, so
// every component agrees without any stored state. Exactly one in every
// WITHDRAWAL_CYCLE_WEEKS consecutive ISO weeks returns true.
export function inWithdrawalPeriod(now: Date = new Date()): boolean {
  return isoWeekNumber(now) % WITHDRAWAL_CYCLE_WEEKS === 0;
}
