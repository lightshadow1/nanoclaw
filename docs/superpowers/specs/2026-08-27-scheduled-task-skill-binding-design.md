# Scheduled Task Skill Binding and Provenance — Design

**Status:** proposed, pending approval and implementation
**Date:** 2026-08-27
**Sequence:** 4 of 6
**Depends on:** Sequence 3 execution-context logging
**Required before:** none

## Problem

NanoClaw already copies installed container skills into each group's Claude
home and exposes the Agent SDK `Skill` tool. Scheduled prompts can ask the model
to use a skill, but the relationship is implicit:

- task rows do not declare required skills;
- missing or renamed skills are discovered only during execution;
- run logs cannot show which skill contents were available or intended;
- editing a skill silently changes future scheduled behavior;
- long procedural instructions tend to be duplicated inside task prompts.

The missing feature is binding and provenance, not another skill runtime.

## Goal

Let a scheduled task declare an ordered list of installed skills, validate those
bindings before execution, require the agent to load them, and record immutable
content hashes with each run.

## Non-goals

- No skill marketplace, installer, updater, or remote URL loading.
- No agent-created or agent-modified skills.
- No automatic extraction of existing Soul prompts into skills.
- No copying full skill bodies into the task database.
- No guarantee that a model follows skill instructions correctly.
- No arbitrary file path bindings.
- No skill version pinning that keeps historical content copies forever.

## Invariants

1. Bindings reference names from the host's installed `container/skills`
   catalog, never caller paths.
2. Name resolution rejects traversal, symlinks leaving the catalog, and
   duplicate names.
3. The ordered binding list is host-validated before a claim enters a container.
4. Every attempted run records the resolved skill hashes or the validation
   failure.
5. Skill access remains subordinate to the task's capability profile.

## Design

### 1. Persist ordered skill names

Add:

```sql
ALTER TABLE scheduled_tasks ADD COLUMN skills_json TEXT NOT NULL DEFAULT '[]';
```

Expose in TypeScript as `skills: string[]`, parsing at the database boundary.
Validation rules:

- maximum 8 skills per task;
- name length 1–80 characters;
- names match `^[a-z0-9][a-z0-9._-]*$`;
- no duplicates;
- serialized value maximum 2 KiB.

Malformed stored JSON is an execution validation error, not an empty list.

### 2. Build a local installed-skill catalog

Add `src/skill-catalog.ts` to enumerate direct child directories of
`container/skills`. A valid skill contains `SKILL.md` and resolves inside the
catalog after `realpath` checks.

For each skill compute a deterministic SHA-256 content hash over:

- normalized relative file paths, sorted bytewise;
- the raw bytes of `SKILL.md`;
- referenced/local files under `references/`, `templates/`, and `scripts/`;
- excluding generated metadata, `.DS_Store`, logs, and VCS files.

Hash the complete allowed skill directory rather than only `SKILL.md`, because
supporting scripts/templates affect behavior. Reject symlinks in version 1.

Catalog output:

```ts
interface InstalledSkill {
  name: string;
  description: string | null;
  contentHash: string;
  relativeFiles: string[];
}
```

Description parsing is informational; name and hash are authoritative.

### 3. Validate at creation and execution

`schedule_task` accepts optional `skills: string[]`. The host validates every
name against the catalog before creating the row. Non-main and main callers use
the same catalog; capability profiles decide whether the SDK `Skill` tool is
available.

Validate again after claiming and before container creation. This catches a
skill removed or changed after task creation.

Policy for a missing skill:

- do not run the container;
- finalize the claim with `status='error'` in the run log;
- advance the schedule normally to avoid a hot loop;
- preserve the task as active so restoring the skill repairs future runs;
- include only the skill name, not filesystem paths, in user-visible errors.

A changed hash is not an error by default. Record the new hash, log a structured
`Scheduled task skill changed` event, and run. Optional strict pinning is
deferred because it requires retained historical skill artifacts and explicit
upgrade workflows.

### 4. Require ordered loading

Pass resolved bindings to `ContainerInput`:

```ts
skills: Array<{ name: string; contentHash: string }>;
```

The agent runner prepends a generated instruction after the scheduled-task
banner and before the user prompt:

```text
Required procedure: load these installed skills in order using the Skill tool
before executing the task: skill-a, skill-b. If any cannot be loaded, stop and
report the failure; do not improvise a replacement.
```

Do not append skill contents. The SDK's progressive skill loading remains the
runtime. Tasks with no bindings receive no extra instruction.

The selected capability profile must include `Skill`; otherwise validation
fails before container creation. Version 1 profiles `full`,
`soul-maintenance`, and `research` permit skills; `read-only` does not unless
Sequence 3's final approved registry says otherwise.

### 5. Record run provenance

Extend Sequence 3's `task_run_logs.execution_context` JSON:

```json
{
  "capability_profile": "research",
  "profile_version": 1,
  "skills": [{ "name": "blogwatcher", "sha256": "..." }]
}
```

Record the ordered list for successful, failed, skipped, and timed-out runs. A
capability-hook skip records intended bindings and hashes if validation already
occurred. To avoid catalog work for frequently skipped tasks, execution order
is:

1. claim;
2. resolve and validate the cheap capability-profile name;
3. run the deterministic capability gate;
4. if allowed, resolve skill files and hashes;
5. run or record validation error.

Therefore a gate-skipped occurrence may record bindings as unresolved; its
context includes `skills_declared` but not hashes. This distinction must be
explicit in the JSON schema.

### 6. Surface bindings in task inspection

Include skill names, but not hashes or file lists, in `list_tasks` snapshots.
Main and group authorization follows current task-list rules.

No general `update_task` API is added. To change bindings through chat, the
owner recreates the task in version 1. Built-in host registration may reconcile
its declared skills idempotently if and when Soul procedures are extracted.

## Files expected to change

- `src/skill-catalog.ts` and tests
- `src/types.ts`, `src/db.ts`, `src/db.test.ts`
- `src/task-scheduler.ts` and tests
- `src/container-runner.ts`
- `src/ipc.ts`, `src/ipc-auth.test.ts`
- `container/agent-runner/src/index.ts`
- `container/agent-runner/src/ipc-mcp-stdio.ts`
- task snapshot serialization

## Tests

### Catalog

- Stable hash is independent of directory enumeration order.
- Any byte or relative-path change changes the hash.
- Traversal names, escaping symlinks, missing `SKILL.md`, duplicate names, and
  excessive file counts/sizes are rejected.
- Only approved supporting directories contribute to the hash.

### Database and IPC

- Existing tasks migrate to `[]`.
- Ordered bindings round-trip without reordering.
- Invalid JSON fails visibly.
- Creation rejects missing, duplicate, malformed, or too many skill names.
- Group authorization remains unchanged.

### Execution

- Required skills appear in the generated instruction in declared order.
- No-binding tasks receive the original prompt unchanged except for the existing
  scheduled banner.
- Missing skill finalizes the claim, logs an error run, and advances next run.
- Profile without `Skill` rejects a nonempty binding before container creation.
- Execution context contains ordered hashes and stays under its size bound.
- A changed hash is logged and used, not silently omitted.
- Capability-gated skips distinguish declared from resolved skills.

## Migration and rollout

Ship catalog/hash computation with no bound production tasks first and measure
startup/runtime cost. Catalogs should be cached by directory metadata but
revalidated for each allowed run; correctness must not depend solely on mtimes.

Then bind one low-risk scheduled task to one reviewed local skill and verify:

- expected Skill invocation in container logs;
- run context hash matches a local recomputation;
- missing-skill failure is understandable and recoverable;
- no prompt content or skill bodies are written into task logs.

Do not convert Soul prompts into skills as part of infrastructure rollout.

## Acceptance criteria

- Tasks can declare ordered, locally installed skill names.
- Invalid or missing bindings prevent execution safely.
- Agent prompts require progressive loading rather than embedding skill bodies.
- Every executed run records deterministic skill hashes.
- Existing unbound tasks behave exactly as before.

## Deferred decisions

- Strict hash pins and retained historical skill packages.
- User-approved skill upgrades for pinned tasks.
- Skill creation/update by the Soul.
- Remote skill installation and namespaced plugin catalogs.
