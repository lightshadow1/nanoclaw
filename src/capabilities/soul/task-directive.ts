// Research journal: one `_Directive.md` per journal task, showing the owner
// what the task is told to do so they can comment on its goal. The host
// refreshes it from the task's live prompt just before each run. Comments on
// it go through the normal comment pass into `_Steering.md`, and the page
// lists the active steers, so it shows what the run will actually do. The
// prompt itself is never rewritten.

import fs from 'fs';
import path from 'path';
import { findUnhandledComments, JOURNAL_DIR } from './research-journal.js';

export const DIRECTIVE_FILE = '_Directive.md';
const STEERING_FILE = '_Steering.md';

const SUMMARY_HEADING = '## In short';
const STEERS_HEADING = '## Your steers';
// Last section: everything below it is the prompt.
const INSTRUCTION_HEADING = '## The instruction (verbatim)';
const HEADINGS = [SUMMARY_HEADING, STEERS_HEADING, INSTRUCTION_HEADING];
// The run replaces this (research-journal-prompts.ts tells it to).
const SUMMARY_PLACEHOLDER =
  '_Not written yet. The next run summarizes its instructions here._';

export interface DirectiveInput {
  name: string; // folder under Research Journal/Tasks/
  taskId: string;
  scheduleType: 'cron' | 'interval' | 'once';
  scheduleValue: string;
  prompt: string;
  steers: string[];
  today: string; // local YYYY-MM-DD
}

const CODE_SPAN = /(`[^`]*`)/;
const FENCE = /^\s{0,3}(```|~~~)/;

// Obsidian reads <today>-style placeholders as HTML and hides them, and a
// pair of $ as math, so escape both outside code. Prompt headings drop one
// level to sit under the page's own sections.
export function renderPromptMarkdown(prompt: string): string {
  let inFence = false;
  const lines = prompt.split('\n').map((line) => {
    if (FENCE.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;
    // split() with a capture group puts the code spans at the odd indexes.
    const parts = line.split(CODE_SPAN);
    for (let i = 0; i < parts.length; i += 2) {
      parts[i] = parts[i].replace(/[<$]/g, (c) => `\\${c}`);
    }
    const escaped = parts.join('');
    return /^#{1,5} /.test(escaped) ? `#${escaped}` : escaped;
  });
  return `${lines.join('\n').trim()}\n`;
}

const WEEKDAYS = [
  'Sundays',
  'Mondays',
  'Tuesdays',
  'Wednesdays',
  'Thursdays',
  'Fridays',
  'Saturdays',
];

export function describeSchedule(
  type: DirectiveInput['scheduleType'],
  value: string,
): string {
  if (type === 'interval') {
    const minutes = Math.round(Number(value) / 60_000);
    if (minutes > 0) {
      if (minutes % 60 === 0) {
        const hours = minutes / 60;
        return `every ${hours} hour${hours === 1 ? '' : 's'}`;
      }
      return `every ${minutes} minute${minutes === 1 ? '' : 's'}`;
    }
  }
  if (type === 'cron') {
    const m = /^(\d{1,2}) (\d{1,2}) \* \* (\*|[0-7])$/.exec(value.trim());
    if (m) {
      const time = `${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')}`;
      return m[3] === '*'
        ? `daily ${time}`
        : `${WEEKDAYS[Number(m[3]) % 7]} ${time}`;
    }
  }
  return `${type} ${value}`;
}

// Unchecked lines of `_Steering.md`: standing steers and once-steers not yet
// applied.
export function activeSteers(steering: string): string[] {
  const steers: string[] = [];
  for (const line of steering.split('\n')) {
    const m = /^\s*[-*] \[ \] (.+)$/.exec(line);
    if (m) steers.push(m[1].trim());
  }
  return steers;
}

function sectionBody(page: string, heading: string): string | null {
  const lines = page.split('\n');
  const start = lines.indexOf(heading);
  if (start === -1) return null;
  let end = lines.length;
  if (heading !== INSTRUCTION_HEADING) {
    const next = lines.findIndex((l, i) => i > start && HEADINGS.includes(l));
    if (next !== -1) end = next;
  }
  return lines
    .slice(start + 1, end)
    .join('\n')
    .trim();
}

// What a section says once the comments are taken out, so a prompt with the
// owner's comments in it still counts as the same prompt.
function withoutComments(markdown: string): string {
  return markdown
    .replace(/\{>>[\s\S]*?<<\}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// The page for `d`, built on the existing one: its summary is kept, and its
// instruction too (comments included) while the prompt is unchanged. Only the
// steers are always rebuilt.
export function buildDirectivePage(
  existing: string | null,
  d: DirectiveInput,
): string {
  const rendered = renderPromptMarkdown(d.prompt);
  const oldInstruction = existing
    ? sectionBody(existing, INSTRUCTION_HEADING)
    : null;
  const keep =
    oldInstruction !== null &&
    withoutComments(oldInstruction) === withoutComments(rendered);
  const instruction = keep ? `${oldInstruction}\n` : rendered;
  const copied =
    (keep && existing && /^copied: (\S+)$/m.exec(existing)?.[1]) || d.today;
  const summary =
    (existing && sectionBody(existing, SUMMARY_HEADING)) || SUMMARY_PLACEHOLDER;
  const steers =
    d.steers.length > 0
      ? d.steers.map((s) => `- ${s}`).join('\n')
      : 'None yet.';
  const steering = `[[${JOURNAL_DIR}/Tasks/${d.name}/_Steering|_Steering]]`;
  const schedule = describeSchedule(d.scheduleType, d.scheduleValue);

  return `---
type: directive
source: ${d.name}
task: ${d.taskId}
schedule: ${JSON.stringify(`${d.scheduleType} ${d.scheduleValue}`)}
copied: ${copied}
---
# ${d.name} — directive

What the ${d.name} task is told to do. NanoClaw refreshes this page just before each run (${schedule}): the instruction at the bottom is the task's prompt word for word, copied ${copied}, and *Your steers* lists the steers from your comments that every run applies.

Comment on any line with \`{>> your comment <<}\`. The next run applies a comment that has no reply yet, and within about 2 hours the comment pass replies and files it as a steer in ${steering}. The prompt itself is never rewritten. Answered comments stay where you left them until the prompt changes.

${SUMMARY_HEADING}

${summary}

${STEERS_HEADING}

${steers}

${INSTRUCTION_HEADING}

${instruction}`;
}

export type DirectiveRefresh = 'written' | 'unchanged' | 'deferred';

// Rewrite the task's page if anything changed. A page with an owner comment
// that has no reply yet is left alone: the run and the comment pass read it
// first, and rewriting could lose the comment.
export function refreshTaskDirective(
  vaultPath: string,
  name: string,
  task: {
    id: string;
    prompt: string;
    schedule_type: DirectiveInput['scheduleType'];
    schedule_value: string;
  },
  today: string,
): DirectiveRefresh {
  const dir = path.join(vaultPath, JOURNAL_DIR, 'Tasks', name);
  const file = path.join(dir, DIRECTIVE_FILE);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;
  if (existing && findUnhandledComments(existing).length > 0) return 'deferred';
  const steeringFile = path.join(dir, STEERING_FILE);
  const page = buildDirectivePage(existing, {
    name,
    taskId: task.id,
    scheduleType: task.schedule_type,
    scheduleValue: task.schedule_value,
    prompt: task.prompt,
    steers: fs.existsSync(steeringFile)
      ? activeSteers(fs.readFileSync(steeringFile, 'utf-8'))
      : [],
    today,
  });
  if (page === existing) return 'unchanged';
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, page, 'utf-8');
  return 'written';
}
