import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openDashboardDatabase, readDashboardRows } from './dashboard-data.js';
import { dashboardCli } from './dashboard-cli.js';

let directory: string;
let filename: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-data-'));
  filename = path.join(directory, 'messages.db');
  const db = new Database(filename);
  db.exec(`CREATE TABLE scheduled_tasks (id TEXT, group_folder TEXT, status TEXT, schedule_type TEXT, schedule_value TEXT,
    next_run TEXT, last_run TEXT, capability_profile TEXT, max_runtime_ms INTEGER, claim_token TEXT, claimed_at TEXT, prompt TEXT);
    CREATE TABLE task_run_logs (id INTEGER, task_id TEXT, run_at TEXT, duration_ms INTEGER, status TEXT, result TEXT, error TEXT);
    INSERT INTO scheduled_tasks VALUES ('job','main','active','cron','0 9 * * *',NULL,NULL,'research',3600000,'SECRET',datetime('now'),'PRIVATE PROMPT');
    INSERT INTO task_run_logs VALUES (1,'job','2026-09-10T00:00:00Z',123,'timed_out','PRIVATE RESULT','SECRET ERROR');`);
  db.close();
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

it('reports claimed distinctly and omits private prompt/token/result/error contents', () => {
  const before = fs.readFileSync(filename);
  const tasks = readDashboardRows(filename, 'tasks') as Record<
    string,
    unknown
  >[];
  expect(tasks[0].claim_state).toBe('claimed');
  expect(tasks[0].claim_age_seconds).toBeGreaterThanOrEqual(0);
  expect(JSON.stringify(tasks)).not.toMatch(/SECRET|PRIVATE/);
  const runs = readDashboardRows(filename, 'runs');
  expect(runs).toEqual([
    expect.objectContaining({ status: 'timed_out', duration_ms: 123 }),
  ]);
  expect(JSON.stringify(runs)).not.toMatch(/SECRET|PRIVATE/);
  expect(fs.readFileSync(filename)).toEqual(before);
});

it('opens a connection that rejects mutation and does not initialize missing databases', () => {
  const db = openDashboardDatabase(filename);
  try {
    expect(() => db.exec('DELETE FROM scheduled_tasks')).toThrow();
  } finally {
    db.close();
  }
  const missing = path.join(directory, 'absent.db');
  expect(() => readDashboardRows(missing, 'tasks')).toThrow('unavailable');
  expect(fs.existsSync(missing)).toBe(false);
});

it('distinguishes empty tables from missing tables and handles lock contention', () => {
  expect(() => readDashboardRows(filename, 'souls')).toThrow('schema missing');
  const db = new Database(filename);
  db.exec('DELETE FROM scheduled_tasks');
  expect(readDashboardRows(filename, 'tasks')).toEqual([]);
  db.exec('BEGIN EXCLUSIVE');
  try {
    expect(() => readDashboardRows(filename, 'tasks')).toThrow('busy');
  } finally {
    db.exec('ROLLBACK');
    db.close();
  }
});

it('bounds results and orders newest runs first', () => {
  const db = new Database(filename);
  const add = db.prepare(
    "INSERT INTO task_run_logs VALUES (?,'job','2026-09-10T00:00:00Z',1,'success',NULL,NULL)",
  );
  db.transaction(() => {
    for (let id = 2; id <= 600; id++) add.run(id);
  })();
  db.close();
  const rows = readDashboardRows(filename, 'runs') as { id: number }[];
  expect(rows).toHaveLength(500);
  expect(rows[0].id).toBe(600);
});

it('rejects SQL, inherited object keys and extra CLI arguments', async () => {
  for (const resource of [
    'tasks; DROP TABLE scheduled_tasks',
    '__proto__',
    'constructor',
  ]) {
    expect(() => readDashboardRows(filename, resource)).toThrow('Unknown');
    await expect(dashboardCli([resource])).rejects.toThrow('Usage');
  }
  await expect(dashboardCli(['tasks', '--db', '/other.db'])).rejects.toThrow(
    'Usage',
  );
});
