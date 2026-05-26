// Phase 4.5 host-side experiment store. DB access + deterministic guardrail
// logic. No LLM calls — episodes are written by the check-in container via
// sqlite3 in the prompt; we only read them here. The container does language
// (sentiment classification, backoff reasoning); the host does arithmetic.

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';

import {
  posteriorFor,
  thompsonRanking,
  TIMING_ARMS,
  type BetaPosterior,
  type TimingArm,
} from './timing-bandit.js';
import { inWithdrawalPeriod } from './proactive-budget.js';

export const PROXIMAL_WINDOW_MIN = 90;
export const EPISODE_DECAY_DAYS = 30;
export const MIN_OUTREACH_MULTIPLIER = 0.25;
export const ROLLBACK_REVIEW_DAYS = 7;
export const DRIFT_ALERT_DELTA = 0.25;
export const RECENT_EPISODES_IN_STATE = 20;

export type Outcome = 'replied' | 'ignored' | 'withdrawn';
export type Sentiment = 'positive' | 'neutral' | 'negative';

export interface Episode {
  id: string;
  groupFolder: string;
  planItemId: string | null;
  target: string | null;
  timingArm: string; // TimingArm in practice; stored as TEXT
  sentAt: string;
  messageExcerpt: string | null;
  outcome: Outcome;
  sentiment: Sentiment | null;
  proximalWindowMin: number;
  createdAt: string;
}

export interface BackoffEntry {
  outreach_multiplier: number;
  since?: string;
}

export interface BackoffState {
  targets: Record<string, BackoffEntry>;
}

interface TuningRow {
  id: string;
  group_folder: string;
  version: number;
  state_json: string;
  baseline_efficacy: number | null;
  created_at: string;
  active: number;
}

export interface GuardrailReview {
  ranAt: string;
  skipped: boolean; // self-rate-limited
  seeded: boolean; // first ever review; baseline written
  rolledBack: boolean;
  trailingEfficacy: number | null;
  baselineEfficacy: number | null;
  driftAlerts: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function rowToEpisode(r: {
  id: string;
  group_folder: string;
  plan_item_id: string | null;
  target: string | null;
  timing_arm: string;
  sent_at: string;
  message_excerpt: string | null;
  outcome: Outcome;
  sentiment: Sentiment | null;
  proximal_window_min: number;
  created_at: string;
}): Episode {
  return {
    id: r.id,
    groupFolder: r.group_folder,
    planItemId: r.plan_item_id,
    target: r.target,
    timingArm: r.timing_arm,
    sentAt: r.sent_at,
    messageExcerpt: r.message_excerpt,
    outcome: r.outcome,
    sentiment: r.sentiment,
    proximalWindowMin: r.proximal_window_min,
    createdAt: r.created_at,
  };
}

function isSuccess(ep: Pick<Episode, 'outcome' | 'sentiment'>): boolean {
  if (ep.outcome !== 'replied') return false;
  return ep.sentiment === 'positive' || ep.sentiment === 'neutral';
}

function isFailure(ep: Pick<Episode, 'outcome' | 'sentiment'>): boolean {
  if (ep.outcome === 'ignored') return true;
  if (ep.outcome === 'replied' && ep.sentiment === 'negative') return true;
  return false; // 'withdrawn' counts neither way
}

// Episodes with sent_at within the last `sinceDays`, newest first.
export function getRecentEpisodes(
  db: Database.Database,
  folder: string,
  sinceDays: number,
  now: Date = new Date(),
): Episode[] {
  const cutoff = new Date(now.getTime() - sinceDays * DAY_MS).toISOString();
  const rows = db
    .prepare(
      `SELECT id, group_folder, plan_item_id, target, timing_arm, sent_at,
              message_excerpt, outcome, sentiment, proximal_window_min, created_at
         FROM experiment_episodes
        WHERE group_folder = ? AND sent_at >= ?
        ORDER BY sent_at DESC`,
    )
    .all(folder, cutoff) as Parameters<typeof rowToEpisode>[0][];
  return rows.map(rowToEpisode);
}

// Per-arm Beta posterior from prior + last-EPISODE_DECAY_DAYS success/failure
// counts. The sliding window IS the non-stationarity decay.
export function computePosteriors(
  db: Database.Database,
  folder: string,
  now: Date = new Date(),
): Record<TimingArm, BetaPosterior> {
  const eps = getRecentEpisodes(db, folder, EPISODE_DECAY_DAYS, now);
  const out = {} as Record<TimingArm, BetaPosterior>;
  for (const arm of TIMING_ARMS) {
    let s = 0;
    let f = 0;
    for (const ep of eps) {
      if (ep.timingArm !== arm) continue;
      if (isSuccess(ep)) s++;
      else if (isFailure(ep)) f++;
    }
    out[arm] = posteriorFor(arm, s, f);
  }
  return out;
}

// Counts per arm for the state-file's n field (excludes withdrawn).
function armCounts(
  eps: Episode[],
): Record<TimingArm, { successes: number; failures: number; n: number }> {
  const out = {} as Record<
    TimingArm,
    { successes: number; failures: number; n: number }
  >;
  for (const arm of TIMING_ARMS) out[arm] = { successes: 0, failures: 0, n: 0 };
  for (const ep of eps) {
    const arm = ep.timingArm as TimingArm;
    if (!TIMING_ARMS.includes(arm)) continue;
    if (isSuccess(ep)) {
      out[arm].successes++;
      out[arm].n++;
    } else if (isFailure(ep)) {
      out[arm].failures++;
      out[arm].n++;
    }
  }
  return out;
}

// Success fraction over the last `days`. Withdrawn episodes don't count.
// Returns null when there are no scored episodes (caller decides how to
// interpret "no signal yet").
export function efficacyRate(
  db: Database.Database,
  folder: string,
  days: number,
  now: Date = new Date(),
): number | null {
  const eps = getRecentEpisodes(db, folder, days, now);
  let s = 0;
  let f = 0;
  for (const ep of eps) {
    if (isSuccess(ep)) s++;
    else if (isFailure(ep)) f++;
  }
  const total = s + f;
  if (total === 0) return null;
  return s / total;
}

function clampMultiplier(m: number): number {
  if (!Number.isFinite(m)) return 1.0;
  if (m < MIN_OUTREACH_MULTIPLIER) return MIN_OUTREACH_MULTIPLIER;
  if (m > 1.0) return 1.0;
  return m;
}

function getActiveTuningRow(
  db: Database.Database,
  folder: string,
): TuningRow | undefined {
  return db
    .prepare(
      `SELECT id, group_folder, version, state_json, baseline_efficacy, created_at, active
         FROM experiment_tuning
        WHERE group_folder = ? AND active = 1
        ORDER BY version DESC
        LIMIT 1`,
    )
    .get(folder) as TuningRow | undefined;
}

function getPreviousTuningRow(
  db: Database.Database,
  folder: string,
  activeVersion: number,
): TuningRow | undefined {
  return db
    .prepare(
      `SELECT id, group_folder, version, state_json, baseline_efficacy, created_at, active
         FROM experiment_tuning
        WHERE group_folder = ? AND version < ?
        ORDER BY version DESC
        LIMIT 1`,
    )
    .get(folder, activeVersion) as TuningRow | undefined;
}

function parseBackoffJson(raw: string): BackoffState {
  try {
    const parsed = JSON.parse(raw) as {
      targets?: Record<string, BackoffEntry>;
    };
    return { targets: parsed.targets ?? {} };
  } catch {
    return { targets: {} };
  }
}

// Active backoff state with every multiplier CLAMPED on read. This is the
// hard guardrail — a container that wrote 0.0 (full pause) gets
// MIN_OUTREACH_MULTIPLIER back; structural pause must escalate via
// intervention, not autonomous action.
export function readBackoffState(
  db: Database.Database,
  folder: string,
): BackoffState {
  const row = getActiveTuningRow(db, folder);
  if (!row) return { targets: {} };
  const parsed = parseBackoffJson(row.state_json);
  const targets: Record<string, BackoffEntry> = {};
  for (const [name, entry] of Object.entries(parsed.targets)) {
    targets[name] = {
      ...entry,
      outreach_multiplier: clampMultiplier(entry.outreach_multiplier),
    };
  }
  return { targets };
}

function insertTuningRow(
  db: Database.Database,
  folder: string,
  version: number,
  stateJson: string,
  baselineEfficacy: number | null,
  createdAt: string,
): void {
  db.prepare(
    `INSERT INTO experiment_tuning
       (id, group_folder, version, state_json, baseline_efficacy, created_at, active)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
  ).run(randomUUID(), folder, version, stateJson, baselineEfficacy, createdAt);
}

function deactivateTuningRow(db: Database.Database, id: string): void {
  db.prepare(`UPDATE experiment_tuning SET active = 0 WHERE id = ?`).run(id);
}

// Host-side weekly review. Idempotent and cheap: self-rate-limits to once
// per ROLLBACK_REVIEW_DAYS based on the active row's created_at. If trailing
// 7d efficacy regressed below the active version's baseline, write a new
// version that restores the PRIOR version's state_json (rollback). On large
// efficacy swings in either direction, surface a drift alert in the return
// value (the host logs / forwards to the owner).
export function reviewGuardrails(
  db: Database.Database,
  folder: string,
  now: Date = new Date(),
): GuardrailReview {
  const ranAt = now.toISOString();
  const active = getActiveTuningRow(db, folder);
  const trailing = efficacyRate(db, folder, ROLLBACK_REVIEW_DAYS, now);

  // First-ever review: seed a baseline row, no rollback possible yet.
  if (!active) {
    insertTuningRow(
      db,
      folder,
      1,
      JSON.stringify({ targets: {} }),
      trailing,
      ranAt,
    );
    return {
      ranAt,
      skipped: false,
      seeded: true,
      rolledBack: false,
      trailingEfficacy: trailing,
      baselineEfficacy: null,
      driftAlerts: [],
    };
  }

  // Self-rate-limit. The cadence is anchored to the active row, so this
  // function being called every 2h (from beforeTaskRun) is fine.
  const elapsedMs = now.getTime() - new Date(active.created_at).getTime();
  if (elapsedMs < ROLLBACK_REVIEW_DAYS * DAY_MS) {
    return {
      ranAt,
      skipped: true,
      seeded: false,
      rolledBack: false,
      trailingEfficacy: trailing,
      baselineEfficacy: active.baseline_efficacy,
      driftAlerts: [],
    };
  }

  const driftAlerts: string[] = [];
  if (
    trailing != null &&
    active.baseline_efficacy != null &&
    Math.abs(trailing - active.baseline_efficacy) >= DRIFT_ALERT_DELTA
  ) {
    driftAlerts.push(
      `efficacy moved from ${active.baseline_efficacy.toFixed(2)} to ${trailing.toFixed(2)} (Δ ${(trailing - active.baseline_efficacy).toFixed(2)})`,
    );
  }

  const regressed =
    trailing != null &&
    active.baseline_efficacy != null &&
    trailing < active.baseline_efficacy;

  if (regressed) {
    const prior = getPreviousTuningRow(db, folder, active.version);
    const restoredJson = prior?.state_json ?? JSON.stringify({ targets: {} });
    deactivateTuningRow(db, active.id);
    insertTuningRow(
      db,
      folder,
      active.version + 1,
      restoredJson,
      trailing,
      ranAt,
    );
    return {
      ranAt,
      skipped: false,
      seeded: false,
      rolledBack: true,
      trailingEfficacy: trailing,
      baselineEfficacy: active.baseline_efficacy,
      driftAlerts,
    };
  }

  // Healthy: snapshot a fresh baseline.
  deactivateTuningRow(db, active.id);
  insertTuningRow(
    db,
    folder,
    active.version + 1,
    active.state_json,
    trailing,
    ranAt,
  );
  return {
    ranAt,
    skipped: false,
    seeded: false,
    rolledBack: false,
    trailingEfficacy: trailing,
    baselineEfficacy: active.baseline_efficacy,
    driftAlerts,
  };
}

// Refreshes groups/{folder}/soul/experiment-state.json. Called by the host
// in beforeTaskRun for morning-plan and check-in. Performs a fresh Thompson
// draw on every call — that randomness IS the decision the container then
// reads as `thompson_ranking`.
export function writeExperimentState(
  db: Database.Database,
  groupsDir: string,
  folder: string,
  now: Date = new Date(),
  rng: () => number = Math.random,
): void {
  const posteriors = computePosteriors(db, folder, now);
  const recentRaw = getRecentEpisodes(db, folder, EPISODE_DECAY_DAYS, now);
  const counts = armCounts(recentRaw);

  const posteriorOut: Record<
    TimingArm,
    { alpha: number; beta: number; mean: number; n: number }
  > = {} as Record<
    TimingArm,
    { alpha: number; beta: number; mean: number; n: number }
  >;
  for (const arm of TIMING_ARMS) {
    const p = posteriors[arm];
    posteriorOut[arm] = {
      alpha: p.alpha,
      beta: p.beta,
      mean: p.alpha / (p.alpha + p.beta),
      n: counts[arm].n,
    };
  }

  const recent = recentRaw.slice(0, RECENT_EPISODES_IN_STATE).map((ep) => ({
    sent_at: ep.sentAt,
    target: ep.target,
    timing_arm: ep.timingArm,
    outcome: ep.outcome,
    sentiment: ep.sentiment,
  }));

  const backoff = readBackoffState(db, folder).targets;
  const efficacy7d = efficacyRate(db, folder, 7, now);

  const state = {
    generated_at: now.toISOString(),
    withdrawal_week: inWithdrawalPeriod(now),
    timing: {
      posteriors: posteriorOut,
      thompson_ranking: thompsonRanking(posteriors, rng),
    },
    recent_episodes: recent,
    backoff,
    efficacy_trailing_7d: efficacy7d,
  };

  const dir = path.join(groupsDir, folder, 'soul');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'experiment-state.json'),
    JSON.stringify(state, null, 2),
    'utf-8',
  );
}
