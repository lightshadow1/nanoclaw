# Scheduled Task Capability Profiles — Design

**Status:** proposed, pending approval and implementation
**Date:** 2026-08-27
**Sequence:** 3 of 6
**Depends on:** Sequence 1 scheduled-task recursion guard
**Required before:** bounded deterministic jobs

## Problem

NanoClaw isolates groups with containers and mount boundaries, but every agent
inside a given group receives the same broad execution surface: Bash, file
mutation, web access, delegation/teams, the Skill tool, and every NanoClaw MCP
tool under a wildcard grant. Main-group containers additionally mount the whole
project root read-write.

That breadth is appropriate for an interactive administrator and some complex
production tasks. It is unnecessary for predictable scheduled jobs such as
history research, ledger maintenance, or a read-only audit. A prompt-level rule
cannot provide least privilege because the tools and writable mounts remain
available.

## Goal

Add a small, closed set of host-defined scheduled-task profiles that jointly
control Claude SDK tools, NanoClaw MCP tools, delegation, additional mounts, and
project/group mount writability.

## Non-goals

- No user-defined arbitrary tool lists.
- No universal plugin/toolset registry.
- No change to interactive container permissions.
- No attempt to sandbox Bash with command-pattern allowlists.
- No per-file authorization inside a writable mount.
- No automatic inference of a profile from prompt text.
- No retroactive narrowing of existing user-created tasks during migration.

## Core invariants

1. The host resolves a profile by name from a compiled registry.
2. Unknown profiles fail closed before container creation.
3. SDK tools, MCP schemas, and filesystem mounts are derived from the same
   resolved profile.
4. A profile cannot claim read-only status while retaining Bash against a
   writable relevant mount.
5. Interactive runs use the existing full behavior and ignore task profiles.
6. Sequence 1's prohibition on schedule mutation applies to every scheduled
   profile, including `full`.

## Profiles

Version 1 defines four profiles:

| Profile            | Intended use                                               | SDK surface                                                             | Project/group mounts                          | NanoClaw MCP                                                                      |
| ------------------ | ---------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------- |
| `full`             | Backward-compatible arbitrary agent task                   | Existing SDK tools                                                      | Existing group semantics                      | All authorized non-schedule-mutation tools                                        |
| `soul-maintenance` | Built-in curation, journal, planning, check-in, production | Bash, read/write/edit/search, web, Skill; no teams/delegation           | Main project + group read-write               | Messaging, document, history, Soul/ledger/bet tools; no group/task administration |
| `research`         | Web research and report generation                         | Read/write/edit/search, web, Skill; no Bash, notebook, teams/delegation | Group read-write; additional mounts read-only | Messaging/document/history only                                                   |
| `read-only`        | Audits and evidence gathering                              | Read/search/web; no Bash/write/edit/notebook/delegation                 | Project/group/additional mounts read-only     | History and list/read-only tools only; no outbound messaging                      |

`read-only` may write only to its per-run transport paths required for agent SDK
state and IPC request/response. Those paths must not expose host business data
for mutation. If SDK session state itself requires a writable per-group mount,
use an isolated per-run session directory for this profile.

The exact MCP allowlists are constants reviewed alongside tool registration.
Wildcard `mcp__nanoclaw__*` is not used for restricted profiles.

## Design

### 1. Persist the profile on scheduled tasks

Add:

```sql
ALTER TABLE scheduled_tasks
ADD COLUMN capability_profile TEXT NOT NULL DEFAULT 'full';
```

Extend `ScheduledTask` with:

```ts
capability_profile: 'full' | 'soul-maintenance' | 'research' | 'read-only';
```

Existing tasks migrate to `full`. Built-in Soul task registration explicitly
sets `soul-maintenance`; do not rely on the database default for built-ins.

### 2. Define one host-side profile registry

Create `src/task-capability-profiles.ts` containing immutable definitions:

```ts
interface TaskCapabilityProfile {
  name: TaskCapabilityProfileName;
  sdkTools: readonly string[];
  mcpTools: readonly NanoclawToolName[];
  projectAccess: 'none' | 'read-only' | 'read-write';
  groupAccess: 'read-only' | 'read-write';
  additionalMountAccess: 'none' | 'read-only' | 'configured';
  persistentSessionAccess: boolean;
}
```

Validate registry invariants in unit tests, including:

- profiles without `Write`/`Edit` cannot receive configured read-write mounts;
- profiles with Bash must be explicitly marked as command-capable;
- scheduled mutation MCP tools are absent from every profile;
- every persisted profile union member has a registry entry.

### 3. Resolve before queue/container execution

`runTask` resolves `task.capability_profile` before invoking capability hooks or
creating the group directory. Unknown/corrupt values finalize the claim as an
error and advance the next run normally so the task does not hot-loop.

Pass the resolved profile name—not caller-supplied arrays—through
`ContainerInput`. `runContainerAgent` independently resolves it again so a
future alternate caller cannot inject tool or mount arrays.

### 4. Derive mounts from profile

Extend `buildVolumeMounts(group, isMain, executionProfile)`:

- Interactive profile follows existing behavior exactly.
- Scheduled `full` follows existing behavior exactly.
- `soul-maintenance` preserves main project read-write because current Soul
  prompts read/write SQLite and wiki artifacts there.
- `research` mounts only the group directory read-write and approved additional
  mounts read-only. For main, it does not inherit the full project-root mount.
- `read-only` mounts applicable project/group/additional data read-only.

Keep the agent-runner source read-only. Give IPC and ephemeral SDK state their
own writable mounts. Do not make the whole persistent `.claude` directory
writable for `read-only`; use a temporary or profile-scoped session home and
disable resumption unless a separately reviewed requirement appears.

### 5. Derive SDK and MCP tools from profile

Pass the profile name to the agent runner. It selects `allowedTools` from a
local mirrored constant generated from or tested against the host registry.
Avoid passing arbitrary tool arrays across stdin.

Pass the profile name to `ipc-mcp-stdio.ts`. Register only named tools in the
profile's MCP allowlist. Host IPC authorization remains in force even for
registered tools.

The host and container definitions can drift because they are compiled into
different artifacts. Add a shared JSON manifest under `container/` generated at
build time from the TypeScript registry, or keep a source-controlled manifest
validated by a parity test. The build must fail on drift.

### 6. Control who may choose a profile

Add optional `capability_profile` to `schedule_task`:

- non-main callers may request only `full`, `research`, or `read-only` for their
  own group;
- main may select any profile;
- omitted value defaults to `full` for compatibility;
- `soul-maintenance` is reserved for host-created built-in tasks so arbitrary
  prompts cannot obtain its project/database write surface by name.

Profile changes to an existing task require an explicit future `update_task`
surface; this spec does not add one. Pause/recreate remains the user-facing
path.

### 7. Record execution profile

Add nullable `execution_context TEXT` to `task_run_logs`, storing bounded JSON:

```json
{ "capability_profile": "research", "profile_version": 1 }
```

This column is extended by Sequence 4 for skill hashes. Keep it under 8 KiB and
host-generated. Existing rows remain null.

## Built-in Soul task mapping

All five current built-in Soul tasks use `soul-maintenance` initially. Although
some could eventually be narrowed further, splitting them before observing the
first profile rollout risks breaking implicit prompt dependencies. After soak,
consider a dedicated `soul-read-only-research` profile for production.

## Files expected to change

- `src/task-capability-profiles.ts` (new) and tests
- `src/types.ts`, `src/db.ts`, `src/db.test.ts`
- `src/task-scheduler.ts` and tests
- `src/container-runner.ts` and mount-security tests
- `src/ipc.ts`, `src/ipc-auth.test.ts`
- `container/agent-runner/src/index.ts`
- `container/agent-runner/src/ipc-mcp-stdio.ts`
- `src/capabilities/soul/index.ts`
- shared/generated profile manifest and build validation

## Tests

- Migration defaults every existing task to `full`.
- Each profile yields the exact expected SDK, MCP, and mount sets.
- Unknown/corrupt profile fails before container creation and finalizes claim.
- Restricted profile cannot request an unavailable MCP tool.
- `read-only` cannot mutate group, project, or additional-mounted data through
  SDK file tools or Bash because those tools/mount modes are absent.
- `research` can write its group output but not project-root or extra data.
- Non-main cannot request `soul-maintenance` or target another group.
- All built-in Soul tasks are registered as `soul-maintenance` and retain their
  existing capability-gate behavior.
- Profile manifest parity fails loudly on host/container drift.
- Task-run context records the resolved profile.

## Rollout

Ship in two stages:

1. Schema, registry, `full` compatibility path, logging, and Soul profile
   annotations while all executions remain effectively full behind a temporary
   deployment flag.
2. Enable enforcement on staging, rebuild the container image, then exercise
   each profile with positive and negative probes.

Keep `TASK_PROFILE_ENFORCEMENT=false` as a temporary rollback switch for one
release. It may force all tasks to `full` but must not bypass Sequence 1's
recursion guard. Remove the switch after a successful soak; permanent dual
behavior is not desired.

## Acceptance criteria

- Every scheduled task resolves one known profile.
- Restricted profiles are enforced across tools and mounts, not only prompts.
- Existing tasks behave as `full` after migration.
- Built-in Soul tasks complete under `soul-maintenance`.
- Interactive behavior is unchanged.
- Run logs identify the applied profile.
