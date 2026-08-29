import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TASK_RUNTIME_MS,
  MAX_TASK_RUNTIME_MS,
  MIN_TASK_RUNTIME_MS,
  resolveNewTaskRuntimeBudget,
} from './task-runtime-budget.js';

describe('scheduled task runtime budget validation', () => {
  it('defaults new tasks to one hour', () => {
    expect(resolveNewTaskRuntimeBudget(undefined, false)).toBe(DEFAULT_TASK_RUNTIME_MS);
  });

  it('accepts integer limits and rejects values outside them', () => {
    expect(resolveNewTaskRuntimeBudget(MIN_TASK_RUNTIME_MS, false)).toBe(MIN_TASK_RUNTIME_MS);
    expect(resolveNewTaskRuntimeBudget(MAX_TASK_RUNTIME_MS, false)).toBe(MAX_TASK_RUNTIME_MS);
    for (const value of [MIN_TASK_RUNTIME_MS - 1, MAX_TASK_RUNTIME_MS + 1, 60000.5, '60000']) {
      expect(() => resolveNewTaskRuntimeBudget(value, false)).toThrow();
    }
  });

  it('allows only main to explicitly create an unbounded task', () => {
    expect(resolveNewTaskRuntimeBudget(null, true)).toBeNull();
    expect(() => resolveNewTaskRuntimeBudget(null, false)).toThrow('Only main');
  });
});
