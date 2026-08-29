export interface PromptSkillBinding {
  name: string;
  contentHash: string;
}

const SCHEDULED_BANNER =
  '[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]';

export function buildScheduledTaskPrompt(
  prompt: string,
  skills: PromptSkillBinding[] = [],
  absoluteTimeoutMs?: number,
): string {
  const sections = [SCHEDULED_BANNER];
  if (absoluteTimeoutMs !== undefined) {
    sections.push(
      `Execution deadline: this task has an absolute wall-clock budget of ${absoluteTimeoutMs}ms. Finish and report within that budget; activity does not extend it.`,
    );
  }
  if (skills.length > 0) {
    sections.push(
      `Required procedure: load these installed skills in order using the Skill tool before executing the task: ${skills.map((skill) => skill.name).join(', ')}. If any cannot be loaded, stop and report the failure; do not improvise a replacement.`,
    );
  }
  sections.push(prompt);
  return sections.join('\n\n');
}
