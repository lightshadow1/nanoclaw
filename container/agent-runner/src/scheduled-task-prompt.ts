export interface PromptSkillBinding {
  name: string;
  contentHash: string;
}

const SCHEDULED_BANNER =
  '[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]';

export function buildScheduledTaskPrompt(
  prompt: string,
  skills: PromptSkillBinding[] = [],
): string {
  const sections = [SCHEDULED_BANNER];
  if (skills.length > 0) {
    sections.push(
      `Required procedure: load these installed skills in order using the Skill tool before executing the task: ${skills.map((skill) => skill.name).join(', ')}. If any cannot be loaded, stop and report the failure; do not improvise a replacement.`,
    );
  }
  sections.push(prompt);
  return sections.join('\n\n');
}
