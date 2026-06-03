import type {
  CapabilityHooks,
  ScheduledTaskInfo,
  StoredMessage,
  SentMessage,
} from './types.js';
import { logger } from '../logger.js';

interface RegisteredHook {
  name: string;
  hooks: CapabilityHooks;
}

let registered: RegisteredHook[] = [];

export function registerHooks(name: string, hooks: CapabilityHooks): void {
  registered.push({ name, hooks });
}

export function dispatchMessageStored(msg: StoredMessage): void {
  for (const { name, hooks } of registered) {
    if (!hooks.onMessageStored) continue;
    try {
      hooks.onMessageStored(msg);
    } catch (err) {
      logger.error({ capability: name, err }, 'Hook error in onMessageStored');
    }
  }
}

export function dispatchMessageSent(msg: SentMessage): void {
  for (const { name, hooks } of registered) {
    if (!hooks.onMessageSent) continue;
    try {
      hooks.onMessageSent(msg);
    } catch (err) {
      logger.error({ capability: name, err }, 'Hook error in onMessageSent');
    }
  }
}

// Resolve an optional per-task model override from capabilities. First
// non-undefined wins; undefined → caller uses the default model.
export function dispatchTaskModel(
  task: ScheduledTaskInfo,
): string | undefined {
  for (const { name, hooks } of registered) {
    if (!hooks.taskModel) continue;
    try {
      const model = hooks.taskModel(task);
      if (model) return model;
    } catch (err) {
      logger.error({ capability: name, err }, 'Hook error in taskModel');
    }
  }
  return undefined;
}

export async function dispatchBeforeTaskRun(
  task: ScheduledTaskInfo,
): Promise<boolean> {
  for (const { name, hooks } of registered) {
    if (!hooks.beforeTaskRun) continue;
    try {
      const allow = await hooks.beforeTaskRun(task);
      if (allow === false) {
        logger.info(
          { capability: name, taskId: task.id },
          'Task skipped by capability hook',
        );
        return false;
      }
    } catch (err) {
      // A hook error shouldn't block the task — fail open.
      logger.error({ capability: name, err }, 'Hook error in beforeTaskRun');
    }
  }
  return true;
}

export async function dispatchShutdown(): Promise<void> {
  for (const { name, hooks } of registered) {
    if (!hooks.onShutdown) continue;
    try {
      await hooks.onShutdown();
    } catch (err) {
      logger.error({ capability: name, err }, 'Hook error in onShutdown');
    }
  }
}

export function clearHooks(): void {
  registered = [];
}
