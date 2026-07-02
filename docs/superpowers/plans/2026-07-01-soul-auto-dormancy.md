# Soul Auto-Dormancy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically mark a spawned soul dormant after 30 days with no routed memory, and auto-resurrect it the moment its topic resurfaces — all host-side, silent.

**Architecture:** Two host-side pieces keyed on the existing deterministic router. (1) Widen the router to also route to dormant souls; after each router pass, `markActive` any dormant soul that received rows. (2) A daily `sweepIdleSouls` pass (in the morning-plan `beforeTaskRun` hook) marks active spawned souls dormant when `max(newest routed-row ts, spawned_at)` is older than 30 days.

**Tech Stack:** TypeScript, better-sqlite3, vitest. All host-side (no container/sqlite3-CLI dependency).

## Global Constraints

- Idle window = `DORMANT_THRESHOLD_DAYS` (already `= 30` in `soul-lifecycle.ts:32`). Reuse it; do not hardcode 30.
- A "routed row" = a `memory_stream` row with `source = 'router'` for that soul's `group_folder`.
- Sweep marks **dormant only** (`markDormant`) — never `archive`. Never touches main (`markDormant`/`markActive` already guard `folder === mainFolder`).
- Dormant/resurrect transitions are **silent** — logged only (`markDormant`/`markActive` already `logger.info`). No Telegram message, no new task/table/MCP verb.
- Resurrection reads **registry** state via `getSoul(folder)?.state` and calls `markActive`; the sweep queries the `souls` table for `state='active'`.
- Run tests with `npm test`; focused with `npm test -- soul`. Build with `npm run build`. Both pass before each commit.
- Code change → PR workflow (branch + PR), not direct to `staging`.
- Git hygiene: stage only the explicit files named per task (`git add <file> <file>`). NEVER `git add -A`/`.`/`-u`; before each commit run `git status` and unstage anything unexpected (a phantom `D src/index.ts` has bitten this repo — `git restore --staged src/index.ts` if seen).

Branch: `feat/soul-auto-dormancy`

---

### Task 1: Widen the router to route to dormant souls

**Files:**
- Modify: `src/capabilities/soul/soul-router.ts` (`loadActiveSpawnedSouls` ~line 118; its use at ~line 180)
- Test: `src/capabilities/soul/soul.test.ts` (alongside existing router tests)

**Interfaces:**
- Produces: `loadRoutableSpawnedSouls(db, mainFolder): SpawnedSoulRow[]` (state IN active/dormant). `routeUncuratedObservationsToSpawnedSouls` unchanged in signature; its `RouteResult.perFolder` may now include dormant folders.

- [ ] **Step 1: Write the failing test**

Add to `src/capabilities/soul/soul.test.ts` in the router test area (reuse the file's existing router-test DB setup — an in-memory `getDb()` + `runMigrations`, and however existing tests insert a `souls` row and a `memory_stream` observation; match those helpers exactly). The new assertion: a **dormant** spawned soul whose spawn_reason keywords match an uncurated main observation receives a routed row.

```typescript
  it('routes to dormant souls (so they can be resurrected)', () => {
    const db = getDb();
    runMigrations(db, soulCapability);
    // main observation mentioning "kubernetes"
    db.prepare(
      `INSERT INTO memory_stream (id, group_folder, timestamp, type, source, content, importance, metadata, curated)
       VALUES ('m1','main', datetime('now'), 'observation','user','kubernetes autoscaling notes', 5, NULL, 0)`,
    ).run();
    // a DORMANT soul whose spawn_reason yields the keyword "kubernetes"
    db.prepare(
      `INSERT INTO souls (folder, owner, agent_name, state, spawned_at, state_changed_at, did, spawn_reason)
       VALUES ('k8s','will','K8s Soul','dormant', datetime('now'), datetime('now'), 'did:x', 'monitoring kubernetes')`,
    ).run();

    const res = routeUncuratedObservationsToSpawnedSouls(db, 'main');
    expect(res.perFolder['k8s']).toBeGreaterThan(0);
  });
```

(If the exact `souls` insert columns differ, copy them from `migrations.ts`'s souls DDL / an existing spawn test. Keyword extraction is `extractKeywords(spawn_reason)`; ensure the observation text contains a word the reason produces — adjust both strings together if needed.)

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm test -- soul`
Expected: FAIL — dormant soul gets no rows (router loads active only), `res.perFolder['k8s']` is undefined.

- [ ] **Step 3: Add `loadRoutableSpawnedSouls` and use it**

In `src/capabilities/soul/soul-router.ts`, replace the `loadActiveSpawnedSouls` function with:

```typescript
function loadRoutableSpawnedSouls(
  db: Database.Database,
  mainFolder: string,
): SpawnedSoulRow[] {
  // active AND dormant: dormant souls must still be routing targets so a
  // resurfacing topic can route a row and trigger resurrection (see index.ts).
  return db
    .prepare(
      `SELECT folder, spawn_reason FROM souls
        WHERE state IN ('active', 'dormant') AND folder != ?`,
    )
    .all(mainFolder) as SpawnedSoulRow[];
}
```

And at the call site (~line 180) change:

```typescript
  const spawned = loadRoutableSpawnedSouls(db, mainFolder);
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npm test -- soul`
Expected: PASS.

- [ ] **Step 5: Build and commit**

```bash
npm run build
git add src/capabilities/soul/soul-router.ts src/capabilities/soul/soul.test.ts
git status   # confirm only these two staged; unstage anything else
git commit -m "feat(soul): route to dormant souls so they can be resurrected

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `resurrectRoutedSouls` + wire into the curation hook

**Files:**
- Modify: `src/capabilities/soul/soul-lifecycle.ts` (add function after `markActive` ~line 300)
- Modify: `src/capabilities/soul/index.ts` (import from `./soul-lifecycle.js` ~line 88-93; curation hook router call ~line 846)
- Test: `src/capabilities/soul/soul.test.ts` (alongside lifecycle tests)

**Interfaces:**
- Consumes: `RouteResult.perFolder` (Task 1), `getSoul(folder): ActiveSoul | null`, `markActive(ctx, folder, now)`.
- Produces: `resurrectRoutedSouls(ctx: LifecycleContext, folders: string[], now?: Date): string[]` — for each folder currently `dormant`, `markActive` it; returns the folders resurrected.

- [ ] **Step 1: Write the failing test**

Add to `src/capabilities/soul/soul.test.ts`, reusing the existing lifecycle-test harness (however spawn/markDormant tests build a `LifecycleContext` — the same `lifecycleCtx`/`ctx` used by existing `spawnSoul`/`markDormant` tests; match it exactly). Spawn a soul, mark it dormant, then resurrect via routed folders:

```typescript
  it('resurrectRoutedSouls reactivates a dormant soul that received rows', () => {
    const ctx = makeLifecycleCtx(); // existing lifecycle-test harness
    spawnSoul(ctx, { folder: 'topic', agentName: 'T', owner: 'will', spawnReason: 'x' });
    markDormant(ctx, 'topic');
    expect(getSoul('topic')?.state).toBe('dormant');

    const woke = resurrectRoutedSouls(ctx, ['topic']);
    expect(woke).toEqual(['topic']);
    expect(getSoul('topic')?.state).toBe('active');
  });

  it('resurrectRoutedSouls leaves active souls and unknown folders untouched', () => {
    const ctx = makeLifecycleCtx();
    spawnSoul(ctx, { folder: 'topic2', agentName: 'T', owner: 'will', spawnReason: 'x' });
    const woke = resurrectRoutedSouls(ctx, ['topic2', 'nonexistent']);
    expect(woke).toEqual([]); // topic2 already active, nonexistent has no soul
    expect(getSoul('topic2')?.state).toBe('active');
  });
```

(Match `spawnSoul`'s real argument shape and the harness constructor name to what existing tests use — read them first.)

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm test -- soul`
Expected: FAIL — `resurrectRoutedSouls` not exported.

- [ ] **Step 3: Implement `resurrectRoutedSouls`**

In `src/capabilities/soul/soul-lifecycle.ts`, after `markActive` (~line 300):

```typescript
// Wake any of the given folders that are currently dormant (e.g. the router
// just delivered rows to them — their topic resurfaced). Returns the folders
// actually resurrected. Unknown folders and already-active souls are skipped.
export function resurrectRoutedSouls(
  ctx: LifecycleContext,
  folders: string[],
  now: Date = new Date(),
): string[] {
  const woke: string[] = [];
  for (const folder of folders) {
    const soul = getSoul(folder);
    if (soul && soul.state === 'dormant') {
      markActive(ctx, folder, now);
      woke.push(folder);
    }
  }
  return woke;
}
```

(`getSoul` is already imported in this file — it's used by `markDormant`/`markActive`.)

- [ ] **Step 4: Run the test, verify it passes**

Run: `npm test -- soul`
Expected: PASS.

- [ ] **Step 5: Wire into the curation hook**

In `src/capabilities/soul/index.ts`, add `resurrectRoutedSouls` to the import block from `./soul-lifecycle.js` (~line 88-93). Then change the router call in the `soul-wiki-curation-${MAIN_GROUP_FOLDER}` hook (~line 846) from:

```typescript
        try {
          routeUncuratedObservationsToSpawnedSouls(db, MAIN_GROUP_FOLDER);
        } catch (err) {
          logger.error({ err }, 'soul-router pass failed; continuing curation');
        }
```

to:

```typescript
        try {
          const routed = routeUncuratedObservationsToSpawnedSouls(
            db,
            MAIN_GROUP_FOLDER,
          );
          if (lifecycleCtx) {
            const woke = resurrectRoutedSouls(
              lifecycleCtx,
              Object.keys(routed.perFolder),
            );
            if (woke.length > 0) {
              logger.info({ woke }, 'Resurrected dormant souls on new routed memory');
            }
          }
        } catch (err) {
          logger.error({ err }, 'soul-router pass failed; continuing curation');
        }
```

- [ ] **Step 6: Build, test, commit**

Run: `npm run build && npm test -- soul`
Expected: build clean, soul tests pass.

```bash
git add src/capabilities/soul/soul-lifecycle.ts src/capabilities/soul/index.ts src/capabilities/soul/soul.test.ts
git status   # confirm only these three staged; unstage anything else
git commit -m "feat(soul): auto-resurrect dormant souls on new routed memory

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `sweepIdleSouls` + wire into the morning-plan hook

**Files:**
- Modify: `src/capabilities/soul/soul-lifecycle.ts` (add function after `resurrectRoutedSouls`)
- Modify: `src/capabilities/soul/index.ts` (import ~line 88-93; morning-plan hook ~line 979, after `processPendingSpawnApprovals`)
- Test: `src/capabilities/soul/soul.test.ts`

**Interfaces:**
- Consumes: `DORMANT_THRESHOLD_DAYS`, `markDormant(ctx, folder, now)`, `LifecycleContext`.
- Produces: `sweepIdleSouls(ctx: LifecycleContext, now?: Date): string[]` — marks active spawned souls dormant when idle ≥ threshold; returns the folders dormanted.

- [ ] **Step 1: Write the failing test**

Add to `src/capabilities/soul/soul.test.ts` using the same lifecycle harness. Insert routed rows / control `spawned_at` to hit the boundary. Drive `now` explicitly so the test is deterministic:

```typescript
  it('sweepIdleSouls dormants an active soul idle >30d, keeps a recent one', () => {
    const ctx = makeLifecycleCtx();
    const now = new Date('2026-07-01T00:00:00Z');
    // idle: last routed row 40 days ago
    spawnSoul(ctx, { folder: 'stale', agentName: 'S', owner: 'will', spawnReason: 'x' });
    ctx.db.prepare(`UPDATE souls SET spawned_at = '2026-05-01T00:00:00Z' WHERE folder='stale'`).run();
    ctx.db.prepare(
      `INSERT INTO memory_stream (id, group_folder, timestamp, type, source, content, importance, metadata, curated)
       VALUES ('r1','stale','2026-05-22T00:00:00Z','observation','router','x',5,NULL,0)`,
    ).run();
    // fresh: routed row 5 days ago
    spawnSoul(ctx, { folder: 'fresh', agentName: 'F', owner: 'will', spawnReason: 'x' });
    ctx.db.prepare(`UPDATE souls SET spawned_at = '2026-05-01T00:00:00Z' WHERE folder='fresh'`).run();
    ctx.db.prepare(
      `INSERT INTO memory_stream (id, group_folder, timestamp, type, source, content, importance, metadata, curated)
       VALUES ('r2','fresh','2026-06-26T00:00:00Z','observation','router','x',5,NULL,0)`,
    ).run();

    const dormanted = sweepIdleSouls(ctx, now);
    expect(dormanted).toEqual(['stale']);
    expect(getSoul('stale')?.state).toBe('dormant');
    expect(getSoul('fresh')?.state).toBe('active');
  });

  it('sweepIdleSouls uses spawned_at when there are no routed rows', () => {
    const ctx = makeLifecycleCtx();
    const now = new Date('2026-07-01T00:00:00Z');
    spawnSoul(ctx, { folder: 'old', agentName: 'O', owner: 'will', spawnReason: 'x' });
    ctx.db.prepare(`UPDATE souls SET spawned_at='2026-05-01T00:00:00Z' WHERE folder='old'`).run(); // 61d, no rows
    spawnSoul(ctx, { folder: 'young', agentName: 'Y', owner: 'will', spawnReason: 'x' });
    ctx.db.prepare(`UPDATE souls SET spawned_at='2026-06-28T00:00:00Z' WHERE folder='young'`).run(); // 3d, no rows

    expect(sweepIdleSouls(ctx, now)).toEqual(['old']);
    expect(getSoul('young')?.state).toBe('active');
  });
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm test -- soul`
Expected: FAIL — `sweepIdleSouls` not exported.

- [ ] **Step 3: Implement `sweepIdleSouls`**

In `src/capabilities/soul/soul-lifecycle.ts`, after `resurrectRoutedSouls`:

```typescript
interface IdleCandidateRow {
  folder: string;
  spawned_at: string;
  last_routed: string | null;
}

// Mark active spawned souls dormant when their activity clock —
// max(newest routed row, spawned_at) — is older than DORMANT_THRESHOLD_DAYS.
// Host-side, deterministic; returns the folders it dormanted.
export function sweepIdleSouls(
  ctx: LifecycleContext,
  now: Date = new Date(),
): string[] {
  const rows = ctx.db
    .prepare(
      `SELECT s.folder AS folder, s.spawned_at AS spawned_at,
              (SELECT MAX(ms.timestamp) FROM memory_stream ms
                WHERE ms.group_folder = s.folder AND ms.source = 'router')
                AS last_routed
         FROM souls s
        WHERE s.state = 'active' AND s.folder != ?`,
    )
    .all(ctx.mainFolder) as IdleCandidateRow[];

  const thresholdMs = DORMANT_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
  const dormanted: string[] = [];

  for (const row of rows) {
    try {
      const spawnedMs = new Date(row.spawned_at).getTime();
      const routedMs = row.last_routed ? new Date(row.last_routed).getTime() : 0;
      const clock = Math.max(spawnedMs, routedMs);
      if (now.getTime() - clock > thresholdMs) {
        markDormant(ctx, row.folder, now);
        dormanted.push(row.folder);
      }
    } catch (err) {
      logger.error({ err, folder: row.folder }, 'sweepIdleSouls: failed on soul');
    }
  }
  return dormanted;
}
```

(`markDormant`, `DORMANT_THRESHOLD_DAYS`, and `logger` are already in this file.)

- [ ] **Step 4: Run the test, verify it passes**

Run: `npm test -- soul`
Expected: PASS.

- [ ] **Step 5: Wire into the morning-plan hook**

In `src/capabilities/soul/index.ts`, add `sweepIdleSouls` to the `./soul-lifecycle.js` import block. Then in the `soul-morning-plan-${MAIN_GROUP_FOLDER}` hook, immediately after the `processPendingSpawnApprovals(lifecycleCtx)` try/catch block (ends ~line 994), add:

```typescript
          try {
            const dormanted = sweepIdleSouls(lifecycleCtx);
            if (dormanted.length > 0) {
              logger.info({ dormanted }, 'Swept idle souls dormant');
            }
          } catch (err) {
            logger.error({ err }, 'sweepIdleSouls failed');
          }
```

(Place it inside the existing `if (lifecycleCtx) { ... }` block that wraps `processPendingSpawnApprovals`, so `lifecycleCtx` is non-null.)

- [ ] **Step 6: Build, full test, commit**

Run: `npm run build && npm test`
Expected: build clean, full suite passes (one known-flaky soul.test may need a `npm test -- soul` re-run to confirm green in isolation).

```bash
git add src/capabilities/soul/soul-lifecycle.ts src/capabilities/soul/index.ts src/capabilities/soul/soul.test.ts
git status   # confirm only these three staged; unstage anything else
git commit -m "feat(soul): daily sweep marks idle spawned souls dormant

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Idle signal (max routed-row/spawned_at > 30d) → Task 3 `sweepIdleSouls`. ✓
- Sweep in morning-plan hook after processPendingSpawnApprovals → Task 3 Step 5. ✓
- Router widened to active+dormant → Task 1. ✓
- Auto-resurrect on routed memory, in curation hook after router → Task 2. ✓
- Dormant-only, main guarded, silent/logged → uses existing `markDormant`/`markActive` (guards + logging built in); no notification added. ✓
- No new task/table/MCP verb; reuses `DORMANT_THRESHOLD_DAYS` → honored. ✓

**Placeholder scan:** none. Harness names (`makeLifecycleCtx`, and `spawnSoul`'s arg shape) are flagged to match the file's actual existing lifecycle-test setup — exact values live in the test file and must not be invented.

**Type consistency:** `sweepIdleSouls(ctx, now?) → string[]` and `resurrectRoutedSouls(ctx, folders, now?) → string[]` are consistent between definition (soul-lifecycle.ts), tests, and index.ts call sites. `RouteResult.perFolder: Record<string, number>` (Task 1) feeds `Object.keys(...)` into `resurrectRoutedSouls` (Task 2). `getSoul(folder)?.state` and the `souls.state` values (`'active'|'dormant'`) match across router query, sweep query, and resurrection check.
