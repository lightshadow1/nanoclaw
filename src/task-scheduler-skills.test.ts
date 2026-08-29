import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runContainerAgent, writeTasksSnapshot, dispatchBeforeTaskRun } =
  vi.hoisted(() => ({
    runContainerAgent: vi.fn(),
    writeTasksSnapshot: vi.fn(),
    dispatchBeforeTaskRun: vi.fn(),
  }));

vi.mock('./container-runner.js', () => ({
  runContainerAgent,
  writeTasksSnapshot,
}));
vi.mock('./capabilities/hooks.js', () => ({ dispatchBeforeTaskRun }));
vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { _initTestDatabase, createTask, getDb, getTaskById } from './db.js';
import type { GroupQueue } from './group-queue.js';
import {
  pollSchedulerOnce,
  type SchedulerDependencies,
} from './task-scheduler.js';

function addDueTask(overrides: Partial<Parameters<typeof createTask>[0]> = {}) {
  createTask({
    id: 'skill-task',
    group_folder: 'main',
    chat_jid: 'main@g.us',
    prompt: 'perform the procedure',
    schedule_type: 'once',
    schedule_value: '2026-01-01T00:00:00.000Z',
    context_mode: 'isolated',
    capability_profile: 'research',
    skills: ['agent-browser'],
    next_run: '2026-01-01T00:00:00.000Z',
    status: 'active',
    created_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  });
}

async function executeClaimedTask() {
  let queued: (() => Promise<void>) | undefined;
  const queue = {
    enqueueTask: vi.fn((_jid: string, _id: string, fn: () => Promise<void>) => {
      queued = fn;
    }),
    closeStdin: vi.fn(),
    notifyIdle: vi.fn(),
  } as unknown as GroupQueue;
  const deps = {
    registeredGroups: () => ({
      'main@g.us': {
        name: 'Main',
        folder: 'main',
        trigger: 'always',
        added_at: '2025-01-01',
      },
    }),
    getSessions: () => ({}),
    queue,
    onProcess: vi.fn(),
    sendMessage: vi.fn(),
  } satisfies SchedulerDependencies;
  await pollSchedulerOnce(deps, new Date('2026-01-01T00:01:00.000Z'));
  expect(queued).toBeDefined();
  await queued!();
}

function latestRun() {
  return getDb()
    .prepare('SELECT * FROM task_run_logs ORDER BY id DESC LIMIT 1')
    .get() as {
    status: string;
    error: string | null;
    execution_context: string;
  };
}

describe('scheduled task skill execution', () => {
  beforeEach(() => {
    _initTestDatabase();
    vi.clearAllMocks();
    dispatchBeforeTaskRun.mockResolvedValue(true);
    runContainerAgent.mockResolvedValue({ status: 'success', result: 'done' });
  });

  it('passes ordered hashes to the container and records provenance', async () => {
    addDueTask();
    await executeClaimedTask();
    const input = runContainerAgent.mock.calls[0][1];
    expect(input.skills).toHaveLength(1);
    expect(input.skills[0]).toEqual({
      name: 'agent-browser',
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const context = JSON.parse(latestRun().execution_context);
    expect(context.skills).toEqual([
      { name: 'agent-browser', sha256: input.skills[0].contentHash },
    ]);
  });

  it('fails missing skills before container creation and advances the occurrence', async () => {
    addDueTask({ skills: ['missing-skill'] });
    await executeClaimedTask();
    expect(runContainerAgent).not.toHaveBeenCalled();
    expect(latestRun().status).toBe('error');
    expect(latestRun().error).toContain('missing-skill');
    expect(getTaskById('skill-task')!.status).toBe('completed');
  });

  it('turns malformed persisted skill JSON into a finalized run error', async () => {
    addDueTask();
    getDb()
      .prepare(`UPDATE scheduled_tasks SET skills_json = 'broken' WHERE id = ?`)
      .run('skill-task');
    await executeClaimedTask();
    expect(runContainerAgent).not.toHaveBeenCalled();
    expect(latestRun().error).toContain('malformed JSON');
    expect(() => getTaskById('skill-task')).toThrow('malformed JSON');
  });

  it('records declared names without hashes when the capability gate skips', async () => {
    dispatchBeforeTaskRun.mockResolvedValue(false);
    addDueTask();
    await executeClaimedTask();
    const context = JSON.parse(latestRun().execution_context);
    expect(context.skills_declared).toEqual(['agent-browser']);
    expect(context.skills).toBeUndefined();
    expect(runContainerAgent).not.toHaveBeenCalled();
  });

  it('rejects skill bindings under a profile without Skill access', async () => {
    addDueTask({ capability_profile: 'read-only' });
    await executeClaimedTask();
    expect(runContainerAgent).not.toHaveBeenCalled();
    expect(latestRun().error).toContain('does not permit skills');
  });
});
