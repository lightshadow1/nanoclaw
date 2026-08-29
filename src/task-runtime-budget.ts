export const DEFAULT_TASK_RUNTIME_MS = 60 * 60 * 1000;
export const MIN_TASK_RUNTIME_MS = 60 * 1000;
export const MAX_TASK_RUNTIME_MS = 6 * 60 * 60 * 1000;
export const SOUL_DEFAULT_RUNTIME_MS = 60 * 60 * 1000;
export const SOUL_PRODUCTION_RUNTIME_MS = 2 * 60 * 60 * 1000;

export function resolveNewTaskRuntimeBudget(
  value: unknown,
  isMain: boolean,
): number | null {
  if (value === undefined) return DEFAULT_TASK_RUNTIME_MS;
  if (value === null) {
    if (!isMain) throw new Error('Only main may create an unbounded task');
    return null;
  }
  if (!Number.isInteger(value)) {
    throw new Error('Task runtime budget must be an integer number of milliseconds');
  }
  const runtime = value as number;
  if (runtime < MIN_TASK_RUNTIME_MS || runtime > MAX_TASK_RUNTIME_MS) {
    throw new Error(
      `Task runtime budget must be between ${MIN_TASK_RUNTIME_MS} and ${MAX_TASK_RUNTIME_MS}ms`,
    );
  }
  return runtime;
}
