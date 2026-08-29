# Scheduled Task Recursion Guard — Design

**Status:** proposed, pending approval and implementation
**Date:** 2026-08-27
**Sequence:** 1 of 6
**Depends on:** existing scheduled-task claim ownership
**Required before:** task capability profiles

## Problem

NanoClaw labels container input with `isScheduledTask`, but that label currently
changes only the prompt banner. Interactive and scheduled agents receive the
same Claude SDK tools and the same wildcard `mcp__nanoclaw__*` grant. The MCP
server consequently exposes `schedule_task`, `pause_task`, `resume_task`, and
`cancel_task` during a scheduled execution.

Group authorization still prevents a non-main group from mutating another
group's tasks, but it does not prevent recursion inside the authorized scope. A
bad instruction, prompt injection, or agent mistake can create recurring jobs
from a recurring job, or mutate the schedule that invoked it. Durable claims
prevent duplicate execution of one occurrence; they do not prevent schedule
graph growth.

## Goal

Make schedule mutation unavailable inside scheduled agent runs by construction,
while retaining read-only schedule inspection and preserving all interactive
task-management behavior.

## Non-goals

- No general tool-profile system; that is Sequence 3.
- No change to who may manage which group's tasks.
- No change to scheduling syntax, claims, queueing, or next-run calculation.
- No attempt to detect recursion from prompt text.
- No exception flag that lets arbitrary scheduled prompts re-enable mutation.

## Security invariant

An agent run with `isScheduledTask === true` cannot create, pause, resume,
cancel, or edit scheduled tasks through the NanoClaw MCP server. Enforcement is
at tool registration/dispatch, not merely in the system prompt.

## Design

### 1. Propagate trusted execution context to the MCP server

In `container/agent-runner/src/index.ts`, pass a new environment variable to
the `nanoclaw` MCP subprocess:

```ts
NANOCLAW_IS_SCHEDULED_TASK: containerInput.isScheduledTask ? '1' : '0';
```

This value comes from host-created `ContainerInput`; it is not accepted from an
IPC file or from model-controlled tool arguments.

In `ipc-mcp-stdio.ts`, parse it once:

```ts
const isScheduledTask = process.env.NANOCLAW_IS_SCHEDULED_TASK === '1';
```

### 2. Omit mutation tools from scheduled MCP schemas

Register these tools only when `isScheduledTask` is false:

- `schedule_task`
- `pause_task`
- `resume_task`
- `cancel_task`

Keep `list_tasks` available. A scheduled agent may need schedule state as input,
but it must not alter that state.

Use a small registration helper or conditional block; do not leave the tools
registered with descriptions saying "do not use." Schema omission keeps the
tools out of model context and makes accidental invocation impossible through
normal MCP dispatch.

### 3. Add a host-side defense in depth

Extend task-mutation IPC payloads with execution provenance written by the MCP
server:

```ts
executionContext: 'interactive' | 'scheduled';
```

For the four mutation verbs, `processTaskIpc` rejects
`executionContext === 'scheduled'` and logs a structured warning containing the
verb, source group, and task ID/target group where present.

This is defense in depth for stale container images or direct IPC generation.
It is not the primary identity proof: the verified IPC namespace remains the
source-group identity boundary. Because an agent can currently write files in
its own IPC namespace, a model-supplied `executionContext` alone is not trusted.
Therefore the host must also segregate scheduled task IPC mutation capability:

- Add `executionContext` to `ContainerInput`-derived MCP environment only.
- For scheduled runs, mount the ordinary group IPC namespace as today because
  messaging and Soul verbs require it.
- Have `ipc-mcp-stdio.ts` stamp every emitted payload.
- Treat a missing context as `interactive` temporarily for rolling compatibility.
- After the deployed agent image and host are known aligned, a later cleanup may
  reject missing context for mutation verbs. That cleanup is outside this spec.

The host-side check protects compliant MCP clients. It does not claim to stop a
scheduled agent with Bash from forging an "interactive" IPC file; Sequence 3
closes that broader capability boundary by removing inappropriate Bash and MCP
tools from restricted task profiles.

### 4. Keep interactive behavior unchanged

Interactive main and group agents retain the current schemas and authorization:

- main may target registered groups;
- non-main may mutate only its own group tasks;
- invalid schedule values remain rejected before IPC emission;
- host authorization remains authoritative.

## Files expected to change

- `container/agent-runner/src/index.ts`
- `container/agent-runner/src/ipc-mcp-stdio.ts`
- `src/ipc.ts`
- `src/ipc-auth.test.ts`
- agent-runner/MCP tests if a dedicated harness exists or is added

No database migration is required.

## Tests

### Agent-runner/MCP registration

- Interactive context exposes all four mutation tools and `list_tasks`.
- Scheduled context omits all four mutation tools but exposes `list_tasks`.
- Scheduled context retains `send_message`, `send_document`, and applicable
  Soul tools.
- Emitted interactive mutation payloads carry
  `executionContext: 'interactive'`.

### Host IPC

- Existing group authorization tests remain unchanged and pass.
- A stamped scheduled `schedule_task` request is rejected.
- Scheduled pause/resume/cancel requests are rejected.
- Rejection creates no row changes and emits no task snapshot side effects.
- Missing execution context follows the documented rolling-compatibility rule.

### Regression

- An interactive user can create, list, pause, resume, and cancel a task.
- A scheduled Soul task can still send messages, publish bets, update the
  ledger, and perform its existing work.
- Task claims always finalize when a scheduled agent attempts an unavailable
  tool and returns an ordinary model response.

## Rollout and observability

Deploy the host and rebuilt container image together. On startup and once per
scheduled agent initialization at debug level, log the execution context and
the registered NanoClaw mutation-tool count. Do not log prompts or secrets.

After deployment, verify:

1. built-in Soul tasks still complete;
2. no `Unauthorized scheduled task mutation` warnings occur during normal use;
3. an interactive smoke test can create and cancel a one-shot task;
4. a controlled scheduled test reports that `schedule_task` is unavailable.

## Acceptance criteria

- Scheduled MCP schemas contain no task-mutation tools.
- Interactive task management is behaviorally unchanged.
- Host-side stamped scheduled mutation requests are rejected.
- No schema or public status changes occur.
- Existing scheduler, IPC authorization, and Soul tests pass.

## Deferred decisions

- Whether a future audited task profile may explicitly receive schedule
  mutation. The default remains prohibited, and this spec introduces no bypass.
