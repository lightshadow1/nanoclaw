import { beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, createTask, getTaskById } from './db.js';
import { GroupQueue } from './group-queue.js';
import {
  pollSchedulerOnce,
  type SchedulerDependencies,
} from './task-scheduler.js';

describe('scheduler task claiming', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('does not enqueue a claimed occurrence again on a later poll', async () => {
    createTask({
      id: 'long-running',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'take longer than one poll',
      schedule_type: 'cron',
      schedule_value: '0 * * * *',
      context_mode: 'isolated',
      next_run: '2026-01-01T00:00:00.000Z',
      status: 'active',
      created_at: '2025-01-01T00:00:00.000Z',
    });

    const enqueueTask = vi.fn();
    const deps = {
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as unknown as GroupQueue,
      onProcess: vi.fn(),
      sendMessage: vi.fn(),
    } satisfies SchedulerDependencies;

    await pollSchedulerOnce(deps, new Date('2026-01-01T00:01:00.000Z'));
    await pollSchedulerOnce(deps, new Date('2026-01-01T00:02:00.000Z'));

    expect(enqueueTask).toHaveBeenCalledTimes(1);
    expect(getTaskById('long-running')!.claim_token).toBeTruthy();
  });
});
