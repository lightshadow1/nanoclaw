# Scheduled Task Absolute Runtime Budgets — Design

**Status:** proposed, pending approval and implementation
**Date:** 2026-08-27
**Sequence:** 5 of 6
**Depends on:** existing claim finalization; Sequence 3 execution context
**Required before:** bounded deterministic jobs share the same run-status model

## Problem

NanoClaw has a container activity timeout, but not an absolute scheduled-task
deadline. The current timeout is derived from group configuration, forced to be
at least the idle timeout plus a grace period, and reset whenever meaningful
streaming output arrives. It correctly reaps inactive containers, but an agent
that continues emitting output or invoking tools may run indefinitely.

Scheduled tasks hold a durable claim and occupy a group/global queue slot for
their entire run. An unbounded active task can therefore delay later work,
consume model/tool resources, and leave claims dependent on an operator restart.

## Goal

Add a persisted per-task wall-clock budget that never resets, terminates an
over-budget container with graceful-then-forceful cleanup, finalizes the claim,
records a distinct `timed_out` result, and preserves existing schedule timing.

## Non-goals

- No fixed three-minute global limit.
- No token, API-cost, or tool-call budget.
- No exactly-once guarantee for external messages sent before timeout.
- No retry policy change.
- No replacement for the existing activity/idle timeout.
- No killing of an interactive container due to a scheduled-task budget.

## Timeout model

Two independent clocks remain:

| Clock                | Scope                     | Resets on output? | Purpose                                                     |
| -------------------- | ------------------------- | ----------------: | ----------------------------------------------------------- |
| Activity timeout     | All containers            |               Yes | Reap silent/stuck execution and idle post-result containers |
| Absolute task budget | Scheduled occurrence only |                No | Bound total claimed execution time                          |

Whichever clock expires first initiates one shared idempotent termination path.

## Design

### 1. Persist the budget

Add:

```sql
ALTER TABLE scheduled_tasks ADD COLUMN max_runtime_ms INTEGER;
```

`NULL` means legacy/unbounded absolute runtime while the activity timeout still
applies. Existing rows migrate to null to avoid silently killing established
tasks.

For newly user-created agent tasks:

- omitted value defaults to `3_600_000` (one hour);
- minimum `60_000` (one minute);
- maximum `21_600_000` (six hours);
- only main may explicitly request `null`/unbounded;
- non-main callers must remain within the bounded range.

Built-in Soul task registration explicitly reconciles budgets:

- wiki curation, evening journal, morning plan, check-in: one hour;
- weekly production: two hours.

These are safety ceilings, not expected durations. Revisit them from run-log
percentiles after staging soak.

### 2. Extend types and task management

Add `max_runtime_ms: number | null` to `ScheduledTask` and optional
`max_runtime_ms` to `schedule_task`. Validate at both MCP and host boundaries;
host validation is authoritative.

Include the value in task snapshots and `list_tasks`. This spec does not add a
general edit operation. Existing tasks may receive budgets through built-in
reconciliation, migration tooling, or recreation.

### 3. Start the absolute timer at actual execution

Queue wait must not consume runtime budget. Start the timer inside `runTask`
immediately before `runContainerAgent`, after:

- durable claim acquisition;
- capability-hook gate;
- group/profile/skill validation;
- task snapshot preparation.

Pass `absoluteTimeoutMs` through `ContainerInput` only for scheduled tasks. The
host container runner owns enforcement; the agent runner receives deadline
context only for a concise system banner and cannot extend it.

### 4. Unify idempotent container termination

Refactor `runContainerAgent` around one internal termination controller:

```ts
type TerminationReason = 'activity_timeout' | 'absolute_timeout' | 'host_stop';

requestTermination(reason): void
```

The first reason wins. Subsequent timer/process callbacks are no-ops. The path:

1. marks termination requested;
2. clears both timers;
3. sends the existing graceful container stop;
4. after 15 seconds, force-kills if still alive;
5. waits for the child `close` event;
6. resolves exactly once.

Do not treat output after deadline as permission to reset the absolute timer.
Continue draining stdout/stderr within existing size bounds until close so
diagnostics and already-emitted structured results are not corrupted.

### 5. Return typed timeout information

Extend `ContainerOutput` with an optional machine-readable failure kind:

```ts
errorKind?: 'activity_timeout' | 'absolute_timeout' | 'process_error';
```

The scheduler maps `absolute_timeout` to task-run status `timed_out`. Expand
`TaskRunLog.status` from `'success' | 'error'` to:

```ts
'success' | 'error' | 'timed_out';
```

For an absolute timeout:

- `result` may contain the last bounded structured result for diagnostics;
- `error` is a sanitized message with configured budget and elapsed time;
- execution context records profile, skill provenance, budget, termination
  reason, and whether any outbound/streamed result was observed;
- logs never claim external side effects were rolled back.

An activity timeout after the agent has already produced a successful result
continues to count as success/idle cleanup under existing behavior. An absolute
timeout is always `timed_out`, even if a partial result was emitted, because the
occurrence exceeded its declared contract.

### 6. Finalize claims and schedules exactly once

After timeout, `runTask` uses the existing token-checked
`finalizeClaimedTask`. Next-run calculation is unchanged:

- cron advances from completion/finalization using the current implementation;
- interval advances using the current implementation;
- one-shot becomes completed.

No automatic immediate retry is added. External sends remain at-least-once
across crashes and ambiguous timeouts.

### 7. Shutdown interaction

Host shutdown may terminate active containers through existing queue/process
cleanup. It must not misclassify an operator/service shutdown as a task timeout.
Startup claim recovery remains unchanged and does not synthesize a run log
because the prior process cannot know whether an external effect occurred.

## Files expected to change

- `src/types.ts`, `src/db.ts`, `src/db.test.ts`
- `src/config.ts`, `.env.example` for the new-task default if configurable
- `src/ipc.ts`, `src/ipc-auth.test.ts`
- `src/task-scheduler.ts`, `src/task-scheduler.test.ts`
- `src/container-runner.ts`, `src/container-runner.test.ts`
- `src/capabilities/soul/index.ts`
- task snapshot/MCP schemas

## Tests

### Validation and migration

- Existing rows migrate with null budgets.
- New omitted tasks receive the one-hour default.
- Minimum, maximum, integer, null, and non-main unbounded rules are enforced.
- Built-in Soul tasks reconcile the documented values without moving `next_run`.

### Timer behavior with fake clocks

- Continuous streaming resets activity timeout but not absolute deadline.
- Absolute timeout fires at the configured wall time.
- Activity timeout may fire first.
- First termination reason wins under simultaneous callbacks.
- Graceful stop is attempted once and force kill occurs only after grace.
- Promise resolves and claim finalizes exactly once.
- Timers are cleared on ordinary completion, spawn failure, and shutdown.

### Scheduler semantics

- Timeout status is `timed_out`, not generic `error` or `success`.
- Cron, interval, and one-shot tasks advance exactly as ordinary completed runs.
- Partial output does not convert absolute timeout to success.
- Startup recovery is unchanged.
- Queue slot becomes available after container close.

## Observability

Structured timeout log fields:

- task ID and group folder;
- configured budget and elapsed milliseconds;
- profile name;
- termination reason;
- graceful stop success/failure;
- whether structured output occurred;
- claim finalization success.

Add operational queries/documentation for timeout count and p50/p95/max duration
per task. Do not emit prompt, result, or stderr content at info level.

## Rollout

1. Deploy schema and logging with all existing tasks null.
2. Verify duration distributions on staging and that no existing activity
   timeout behavior changed.
3. Apply explicit budgets to built-in Soul tasks.
4. Create controlled tasks that exceed small test budgets, verify graceful and
   forced paths, and inspect claims/run logs.
5. Enable the one-hour default for newly created tasks.

Rollback may set budgets to null and disable absolute-timer creation. The new
column and `timed_out` historical rows remain readable.

## Acceptance criteria

- New scheduled tasks have bounded wall-clock execution by default.
- Existing tasks are not silently constrained during migration.
- Output activity cannot extend the absolute deadline.
- Timeout produces one `timed_out` log and one token-checked finalization.
- Existing activity timeout and interactive execution behavior remain intact.
