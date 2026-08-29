import { describe, expect, it } from 'vitest';

const promptModule = '../container/agent-runner/src/scheduled-task-prompt.js';

describe('scheduled task prompt skill binding', () => {
  it('requires skill loading in declared order before the task prompt', async () => {
    const { buildScheduledTaskPrompt } = await import(promptModule);
    const prompt = buildScheduledTaskPrompt('do the work', [
      { name: 'first', contentHash: 'a' },
      { name: 'second', contentHash: 'b' },
    ]);
    expect(prompt).toContain(
      'Skill tool before executing the task: first, second',
    );
    expect(prompt.indexOf('first, second')).toBeLessThan(
      prompt.indexOf('do the work'),
    );
    expect(prompt).not.toContain('contentHash');
  });

  it('keeps unbound scheduled prompts at banner plus original prompt', async () => {
    const { buildScheduledTaskPrompt } = await import(promptModule);
    expect(buildScheduledTaskPrompt('do the work')).toBe(
      '[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\ndo the work',
    );
  });
});
