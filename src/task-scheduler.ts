import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';

import {
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  MAX_CONCURRENT_CONTAINERS,
  SCHEDULER_POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import { dispatchBeforeTaskRun } from './capabilities/hooks.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  ClaimedTask,
  claimDueTasks,
  finalizeClaimedTask,
  getAllTasks,
  getLatestTaskExecutionContext,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { RegisteredGroup, ScheduledTask } from './types.js';
import { resolveTaskCapabilityProfile } from './task-capability-profiles.js';
import { resolveSkillBindings } from './skill-catalog.js';

function nextRunFor(task: ScheduledTask): string | null {
  if (task.schedule_type === 'cron') {
    return CronExpressionParser.parse(task.schedule_value, { tz: TIMEZONE }).next().toISOString();
  }
  if (task.schedule_type === 'interval') {
    return new Date(Date.now() + parseInt(task.schedule_value, 10)).toISOString();
  }
  return null;
}

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

async function runTask(
  task: ClaimedTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  if (task.skill_validation_error) {
    const error = task.skill_validation_error;
    finalizeClaimedTask(task.id, task.claim_token, nextRunFor(task), `Error: ${error}`, {
      task_id: task.id, run_at: new Date().toISOString(), duration_ms: Date.now() - startTime,
      status: 'error', result: null, error,
      execution_context: JSON.stringify({
        capability_profile: task.capability_profile, skills_declared: null,
        max_runtime_ms: task.max_runtime_ms,
        skill_validation_error: error,
      }),
    });
    return;
  }
  let profile;
  try {
    profile = resolveTaskCapabilityProfile(task.capability_profile);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    let nextRun: string | null = null;
    if (task.schedule_type === 'cron') {
      nextRun = CronExpressionParser.parse(task.schedule_value, { tz: TIMEZONE })
        .next()
        .toISOString();
    } else if (task.schedule_type === 'interval') {
      nextRun = new Date(Date.now() + parseInt(task.schedule_value, 10)).toISOString();
    }
    finalizeClaimedTask(task.id, task.claim_token, nextRun, `Error: ${error}`, {
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
      execution_context: JSON.stringify({
        capability_profile: task.capability_profile, skills_declared: task.skills,
        max_runtime_ms: task.max_runtime_ms,
      }),
    });
    return;
  }
  const groupDir = path.join(GROUPS_DIR, task.group_folder);
  fs.mkdirSync(groupDir, { recursive: true });

  // Capability gate: skip the run before any container spin-up cost.
  // Skipped runs still advance next_run so the task fires at the next slot.
  const allow = await dispatchBeforeTaskRun({
    id: task.id,
    group_folder: task.group_folder,
    schedule_type: task.schedule_type,
  });
  if (!allow) {
    let nextRun: string | null = null;
    if (task.schedule_type === 'cron') {
      nextRun = CronExpressionParser.parse(task.schedule_value, {
        tz: TIMEZONE,
      })
        .next()
        .toISOString();
    } else if (task.schedule_type === 'interval') {
      nextRun = new Date(
        Date.now() + parseInt(task.schedule_value, 10),
      ).toISOString();
    }
    const finalized = finalizeClaimedTask(
      task.id,
      task.claim_token,
      nextRun,
      'skipped: gated by capability hook',
      {
        task_id: task.id,
        run_at: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        status: 'success',
        result: 'skipped: gated by capability hook',
        error: null,
        execution_context: JSON.stringify({
          capability_profile: profile.name,
          profile_version: profile.version,
          skills_declared: task.skills,
          max_runtime_ms: task.max_runtime_ms,
          skipped: true,
        }),
      },
    );
    if (!finalized) {
      logger.error({ taskId: task.id }, 'Task claim ownership lost');
    }
    return;
  }

  let resolvedSkills;
  try {
    if (task.skills.length > 0 && !profile.skillAccess) {
      throw new Error(`Capability profile ${profile.name} does not permit skills`);
    }
    resolvedSkills = resolveSkillBindings(task.skills);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const finalized = finalizeClaimedTask(
      task.id, task.claim_token, nextRunFor(task), `Error: ${error}`,
      {
        task_id: task.id, run_at: new Date().toISOString(), duration_ms: Date.now() - startTime,
        status: 'error', result: null, error,
        execution_context: JSON.stringify({
          capability_profile: profile.name, profile_version: profile.version,
          skills_declared: task.skills, skill_validation_error: error,
          max_runtime_ms: task.max_runtime_ms,
        }),
      },
    );
    if (!finalized) logger.error({ taskId: task.id }, 'Task claim ownership lost');
    return;
  }

  const previousContext = getLatestTaskExecutionContext(task.id);
  if (previousContext) {
    try {
      const previous = JSON.parse(previousContext) as { skills?: Array<{ name: string; sha256: string }> };
      for (const skill of resolvedSkills) {
        const oldHash = previous.skills?.find((item) => item.name === skill.name)?.sha256;
        if (oldHash && oldHash !== skill.contentHash) {
          logger.info(
            { taskId: task.id, skill: skill.name, previousHash: oldHash, contentHash: skill.contentHash },
            'Scheduled task skill changed',
          );
        }
      }
    } catch { /* Historical context is diagnostic only. */ }
  }

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    const runLog = {
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error' as const,
      result: null,
      error: `Group not found: ${task.group_folder}`,
      execution_context: JSON.stringify({
        capability_profile: profile.name,
        profile_version: profile.version,
        skills: resolvedSkills.map((skill) => ({ name: skill.name, sha256: skill.contentHash })),
        max_runtime_ms: task.max_runtime_ms,
      }),
    };
    // Advance next_run so a genuinely-orphaned task doesn't hot-loop every
    // scheduler poll (it stays due otherwise, re-firing the error forever).
    let nextRun: string | null = null;
    if (task.schedule_type === 'cron') {
      nextRun = CronExpressionParser.parse(task.schedule_value, {
        tz: TIMEZONE,
      })
        .next()
        .toISOString();
    } else if (task.schedule_type === 'interval') {
      nextRun = new Date(
        Date.now() + parseInt(task.schedule_value, 10),
      ).toISOString();
    }
    const finalized = finalizeClaimedTask(
      task.id,
      task.claim_token,
      nextRun,
      'Error: group not found',
      runLog,
    );
    if (!finalized) {
      logger.error({ taskId: task.id }, 'Task claim ownership lost');
    }
    return;
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = task.group_folder === MAIN_GROUP_FOLDER;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
      capability_profile: t.capability_profile,
      skills: t.skills,
      max_runtime_ms: t.max_runtime_ms,
    })),
  );

  let result: string | null = null;
  let error: string | null = null;
  let terminationReason: ContainerOutput['errorKind'];
  let hadStreamedOutput = false;

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

  // After the task produces a result, close the container promptly.
  // Tasks are single-turn — no need to wait IDLE_TIMEOUT (30 min) for the
  // query loop to time out. A short delay handles any final MCP calls.
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Closing task container after result');
      deps.queue.closeStdin(task.chat_jid);
    }, TASK_CLOSE_DELAY_MS);
  };

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt: task.prompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        capabilityProfile: profile.name,
        skills: resolvedSkills,
        absoluteTimeoutMs: task.max_runtime_ms ?? undefined,
        taskId: task.id,
      },
      (proc, containerName) =>
        deps.onProcess(task.chat_jid, proc, containerName, task.group_folder),
      async (streamedOutput: ContainerOutput) => {
        hadStreamedOutput = true;
        if (streamedOutput.result) {
          result = streamedOutput.result;
          // Forward result to user (sendMessage handles formatting)
          await deps.sendMessage(task.chat_jid, streamedOutput.result);
          scheduleClose();
        }
        if (streamedOutput.status === 'success') {
          deps.queue.notifyIdle(task.chat_jid);
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    );

    if (closeTimer) clearTimeout(closeTimer);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
      terminationReason = output.errorKind;
      hadStreamedOutput = hadStreamedOutput || !!output.hadStreamingOutput;
      if (output.result) result = output.result;
    } else if (output.result) {
      // Messages are sent via MCP tool (IPC), result text is just logged
      result = output.result;
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  const runLog = {
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status:
      terminationReason === 'absolute_timeout'
        ? ('timed_out' as const)
        : error
          ? ('error' as const)
          : ('success' as const),
    result,
    error,
    execution_context: JSON.stringify({
      capability_profile: profile.name,
      profile_version: profile.version,
      skills: resolvedSkills.map((skill) => ({ name: skill.name, sha256: skill.contentHash })),
      max_runtime_ms: task.max_runtime_ms,
      termination_reason: terminationReason ?? null,
      had_streamed_output: hadStreamedOutput,
    }),
  };

  let nextRun: string | null = null;
  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    nextRun = interval.next().toISOString();
  } else if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    nextRun = new Date(Date.now() + ms).toISOString();
  }
  // 'once' tasks have no next run

  const resultSummary = terminationReason === 'absolute_timeout'
    ? `Timed out: ${error}`
    : error
      ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  const finalized = finalizeClaimedTask(
    task.id,
    task.claim_token,
    nextRun,
    resultSummary,
    runLog,
  );
  if (!finalized) {
    logger.error({ taskId: task.id }, 'Task claim ownership lost');
  }
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    await pollSchedulerOnce(deps);

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** One scheduler poll, exported to make claim behavior testable. */
export async function pollSchedulerOnce(
  deps: SchedulerDependencies,
  now: Date = new Date(),
): Promise<void> {
  try {
    const claimedTasks = claimDueTasks(now, MAX_CONCURRENT_CONTAINERS);
    if (claimedTasks.length > 0) {
      logger.info({ count: claimedTasks.length }, 'Found due tasks');
    }

    for (const task of claimedTasks) {
      logger.debug(
        {
          taskId: task.id,
          claimToken: task.claim_token.slice(0, 8),
          claimedAt: task.claimed_at,
        },
        'Scheduled task claimed',
      );
      deps.queue.enqueueTask(task.chat_jid, task.id, () => runTask(task, deps));
    }
  } catch (err) {
    logger.error({ err }, 'Error in scheduler loop');
  }
}
