# Soul Auto-Dormancy — Design

**Status:** approved (design), pending implementation
**Date:** 2026-07-01

## Problem

Spawned souls never retire. `markDormant`/`markActive`/`archive`/`resurrect`
exist in `soul-lifecycle.ts` and are unit-tested, but have **zero live call
sites** — the only wired lifecycle edge is `spawn → active`. Staging currently
has 4 active spawned souls (`observability`, `travel-solo`, `agent-isolation`,
`aws-agentcore-adoption`), 0 dormant. Every active soul is serviced forever:
main's wiki-curation Part 2 loops all active spawned souls every 2h, the weekly
production pass loops all active souls, and the check-in gate scans all active
souls' uncurated rows. Spawning is a one-way ratchet with unbounded accumulating
cost.

The intended behavior is encoded but unconnected: `DORMANT_THRESHOLD_DAYS = 30`.

## Goal

Wire an automatic dormancy sweep: a spawned soul idle for 30 days goes dormant
(drops out of curation + production); the instant its topic resurfaces it wakes
automatically. All host-side, deterministic, silent.

## Non-goals

- Not archiving. `archive` (unregisters transport, stronger/less reversible)
  stays a manual/future action. The sweep only ever does `markDormant`.
- Not touching main. `markDormant` already guards `folder === mainFolder`.
- Not owner-facing. No Telegram notification on dormant/resurrect — internal
  housekeeping, logged only (owner silence is the noise baseline).
- No new scheduled task, no new DB table, no MCP tool/IPC verb.

## Design — two host-side pieces, both keyed on the router

Routing is already host-side and deterministic
(`routeUncuratedObservationsToSpawnedSouls`, called at `index.ts:846`), using
`better-sqlite3` — no container/`sqlite3`-CLI dependency. Both pieces build on it.

### Piece 1 — Dormancy sweep (new)

- **Where:** the `soul-morning-plan-${MAIN_GROUP_FOLDER}` `beforeTaskRun` hook
  (`index.ts:975`), immediately after `processPendingSpawnApprovals(lifecycleCtx)`
  (line 979). Fires daily (morning plan is 6 AM cron), host-side, reuses the
  existing `lifecycleCtx`.
- **Idle signal:** for each **active spawned** soul, the activity clock is
  `max(newest routed row timestamp, spawned_at)`, where a "routed row" is a
  `memory_stream` row with `group_folder = <soul.folder>` AND `source = 'router'`.
  If that clock is older than `DORMANT_THRESHOLD_DAYS` (30) → `markDormant`.
- A freshly-spawned soul with no routed rows uses `spawned_at` as the clock, so
  it can't go dormant until 30 days post-spawn.

New function (`soul-lifecycle.ts`):

```
// Returns the folders it marked dormant. Active spawned souls only; main and
// already-dormant/archived souls are skipped.
export function sweepIdleSouls(
  ctx: LifecycleContext,
  now: Date = new Date(),
): string[]
```

Query (one statement, then the JS threshold compare):

```sql
SELECT s.folder, s.spawned_at,
       (SELECT MAX(ms.timestamp) FROM memory_stream ms
         WHERE ms.group_folder = s.folder AND ms.source = 'router') AS last_routed
  FROM souls s
 WHERE s.state = 'active' AND s.folder != ?   -- mainFolder
```

For each row: `clock = max(last_routed ?? spawned_at, spawned_at)`; if
`now - clock > 30 days`, call `markDormant(ctx, folder, now)`. Wrap the loop so
one soul's failure logs and doesn't abort the sweep.

### Piece 2 — Resurrection (modify router + its host integration)

The router today targets active souls only (`loadActiveSpawnedSouls`), so a
dormant soul would never receive a row and could never wake. Fix:

- **Widen the router's target set** to active **+ dormant** spawned souls. Add
  `loadRoutableSpawnedSouls(db, mainFolder)` (state IN ('active','dormant')) and
  use it in `routeUncuratedObservationsToSpawnedSouls`. Keyword matching and
  row insertion are unchanged; `RouteResult.perFolder` may now include dormant
  folders.
- **Resurrect after routing:** at `index.ts:846`, right after the router call,
  for each folder in `perFolder` whose current registry state is `dormant`, call
  `markActive(lifecycleCtx, folder)`. A resurfacing topic thus routes the row
  and wakes the soul in the same pass — symmetric with the idle signal.

This is the one contract change: the router now touches dormant souls. That is
intended and required for auto-resurrect.

## Data flow

- **Daily (6 AM):** morning-plan hook → `processPendingSpawnApprovals` →
  `sweepIdleSouls` → souls with a 30-day-quiet routed-row clock go `dormant`
  (tasks paused, wiki still queryable), logged only.
- **Every 2h (curation hook):** router evaluates active + dormant souls → routes
  matching observations → host `markActive`s any dormant folder that received
  rows. Dormant souls that match nothing stay dormant and cost nothing.

## Edge cases

- **No thrash:** the sweep runs once/day; at most one dormant transition per soul
  per day. A soul dormanted at 6 AM that matches new signal at 8 AM simply wakes
  — correct, not thrash.
- **Router-fed clock:** because Piece 2 routes to dormant souls too, a dormant
  soul that keeps matching keeps its clock fresh and is immediately resurrected;
  it won't be re-dormanted next sweep (it's active with recent routed rows).
- **Registry vs DB state:** `markDormant`/`markActive` update both the `souls`
  row and the in-memory registry; the resurrection check reads registry state
  (`getSoul(folder).state`) so it sees the current value within the pass.

## Testing (host-side, in-memory DB, matching existing soul tests)

- `sweepIdleSouls`: (a) active soul whose newest routed row is 31 days old →
  dormanted; (b) active soul with a routed row 5 days old → untouched; (c)
  soul spawned 31 days ago with zero routed rows → dormanted (spawned_at clock);
  (d) soul spawned 5 days ago, no rows → untouched; (e) main never dormanted.
- Router: `loadRoutableSpawnedSouls` returns active + dormant; a dormant soul
  whose keywords match an observation receives a routed row.
- Resurrection integration: after a router pass that routed ≥1 row to a dormant
  folder, that soul is `active`; active souls and no-match dormant souls are
  unchanged.

## Guardrails honored

No new task/table/MCP verb; reuses `DORMANT_THRESHOLD_DAYS`, `markDormant`,
`markActive`, and the existing host-side router + morning-plan hooks. Sweep is
`markDormant`-only (reversible); `archive` stays out of scope.
