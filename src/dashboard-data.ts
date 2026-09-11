import { execFile } from 'node:child_process';
import Database from 'better-sqlite3';

export const DASHBOARD_RESOURCES = [
  'tasks',
  'runs',
  'souls',
  'bets',
  'containers',
] as const;
export type DashboardResource = (typeof DASHBOARD_RESOURCES)[number];

// No prompts, credentials, claim tokens, message bodies, or arbitrary SQL.
const QUERIES = {
  tasks: `SELECT id, group_folder, status, schedule_type, schedule_value,
    next_run, last_run, capability_profile, max_runtime_ms,
    CASE WHEN claim_token IS NULL THEN 'unclaimed' ELSE 'claimed' END AS claim_state,
    claimed_at,
    CASE WHEN claimed_at IS NULL THEN NULL ELSE MAX(0, strftime('%s','now') - strftime('%s',claimed_at)) END AS claim_age_seconds
    FROM scheduled_tasks ORDER BY next_run IS NULL, next_run, id LIMIT 500`,
  runs: `SELECT id, task_id, run_at, duration_ms, status,
    CASE WHEN error IS NOT NULL AND error != '' THEN 'See private host logs' ELSE NULL END AS error_detail
    FROM task_run_logs ORDER BY run_at DESC, id DESC LIMIT 500`,
  souls: `SELECT folder, agent_name, state, parent_folder, spawned_at, state_changed_at
    FROM souls ORDER BY state, folder LIMIT 500`,
  bets: `SELECT id, group_folder, substr(title,1,300) AS title, status, created_at, sent_at, resolved_at
    FROM bets ORDER BY created_at DESC, id LIMIT 500`,
};

export function openDashboardDatabase(filename: string): Database.Database {
  const database = new Database(filename, {
    readonly: true,
    fileMustExist: true,
    timeout: 250,
  });
  database.pragma('query_only = ON');
  return database;
}

export function readDashboardRows(
  filename: string,
  resource: string,
): unknown[] {
  if (!Object.hasOwn(QUERIES, resource))
    throw new Error('Unknown dashboard resource');
  let database: Database.Database | undefined;
  try {
    database = openDashboardDatabase(filename);
    return database.prepare(QUERIES[resource as keyof typeof QUERIES]).all();
  } catch {
    // A missing optional table is unavailable, not an empty healthy system.
    throw new Error(
      `Cannot read ${resource}: database unavailable, busy, or schema missing`,
    );
  } finally {
    database?.close();
  }
}

export function readDashboardContainers(): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    execFile(
      'docker',
      ['ps', '-a', '--filter', 'name=^/nanoclaw-', '--format', '{{json .}}'],
      {
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout) => {
        if (error) {
          reject(
            new Error('Container status unavailable: Docker cannot be queried'),
          );
          return;
        }
        try {
          const rows = stdout.trim()
            ? stdout
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line))
            : [];
          resolve(
            rows.slice(0, 500).map((row) => ({
              name: row.Names,
              image: row.Image,
              state: row.State,
              status: row.Status,
            })),
          );
        } catch {
          reject(
            new Error('Container status unavailable: invalid Docker response'),
          );
        }
      },
    );
  });
}
