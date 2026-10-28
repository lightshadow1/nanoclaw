import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { findUnhandledComments } from './research-journal.js';
import {
  activeSteers,
  buildDirectivePage,
  describeSchedule,
  refreshTaskDirective,
  renderPromptMarkdown,
  type DirectiveInput,
} from './task-directive.js';

const PROMPT = [
  'You are Scout, a weekly change monitor.',
  '',
  '## How to run',
  'Write `/workspace/extra/notes/Research Journal/Tasks/Scout/<today>.md`.',
  "Insert '<topic, max ~70 chars>' and wrap output in <internal>...</internal>.",
  'Flag deals under $1,000.',
].join('\n');

function input(overrides: Partial<DirectiveInput> = {}): DirectiveInput {
  return {
    name: 'Scout',
    taskId: 't-scout',
    scheduleType: 'cron',
    scheduleValue: '0 10 * * 1',
    prompt: PROMPT,
    steers: [],
    today: '2026-10-27',
    ...overrides,
  };
}

describe('renderPromptMarkdown', () => {
  it('escapes placeholders and dollar signs outside code spans so Obsidian shows them', () => {
    const md = renderPromptMarkdown(PROMPT);
    expect(md).toContain("Insert '\\<topic, max ~70 chars>'");
    expect(md).toContain('\\<internal>...\\</internal>');
    expect(md).toContain('under \\$1,000');
    expect(md).toContain(
      '`/workspace/extra/notes/Research Journal/Tasks/Scout/<today>.md`',
    );
  });

  it('nests the prompt headings under the page section', () => {
    expect(renderPromptMarkdown(PROMPT)).toContain('\n### How to run\n');
  });

  it('leaves fenced code blocks exactly as written', () => {
    const fenced = '```\n## not a heading\ncat <<EOF > $HOME/x\n```';
    expect(renderPromptMarkdown(fenced)).toBe(fenced + '\n');
  });
});

describe('describeSchedule', () => {
  it('names weekly and daily crons, intervals, and falls back to the raw value', () => {
    expect(describeSchedule('cron', '0 10 * * 1')).toBe('Mondays 10:00');
    expect(describeSchedule('cron', '30 9 * * *')).toBe('daily 09:30');
    expect(describeSchedule('cron', '*/15 9-21 * * 1')).toBe(
      'cron */15 9-21 * * 1',
    );
    expect(describeSchedule('interval', '7200000')).toBe('every 2 hours');
    expect(describeSchedule('interval', '900000')).toBe('every 15 minutes');
  });
});

describe('activeSteers', () => {
  it('lists unchecked steers only', () => {
    const steering = [
      '# Steering',
      '- [ ] (standing) cover subagent architectures too — from [[2026-10-26]], 2026-10-27',
      '- [x] (once) recheck the MCP spec — done 2026-10-26',
      'notes',
    ].join('\n');
    expect(activeSteers(steering)).toEqual([
      '(standing) cover subagent architectures too — from [[2026-10-26]], 2026-10-27',
    ]);
  });
});

describe('buildDirectivePage', () => {
  it('builds a page with the verbatim prompt, steers and a summary placeholder', () => {
    const page = buildDirectivePage(
      null,
      input({ steers: ['(standing) drop topic 9'] }),
    );
    expect(page).toMatch(
      /^---\ntype: directive\nsource: Scout\ntask: t-scout\n/,
    );
    expect(page).toContain('copied: 2026-10-27');
    expect(page).toContain('# Scout — directive');
    expect(page).toContain('Mondays 10:00');
    expect(page).toContain(
      '[[Research Journal/Tasks/Scout/_Steering|_Steering]]',
    );
    expect(page).toContain('## In short\n\n_Not written yet');
    expect(page).toContain('## Your steers\n\n- (standing) drop topic 9\n');
    expect(page.endsWith(renderPromptMarkdown(PROMPT))).toBe(true);
    // The how-to-comment example must not read as an owner comment.
    expect(findUnhandledComments(page)).toEqual([]);
  });

  it('says so when there are no steers', () => {
    expect(buildDirectivePage(null, input())).toContain(
      '## Your steers\n\nNone yet.',
    );
  });

  it('is stable: rebuilding an unchanged page returns it as is', () => {
    const page = buildDirectivePage(null, input());
    expect(buildDirectivePage(page, input({ today: '2026-11-02' }))).toBe(page);
  });

  it('keeps the summary written on the page', () => {
    const page = buildDirectivePage(null, input()).replace(
      /_Not written yet[^\n]*/,
      '- **Goal:** catch material change.',
    );
    const next = buildDirectivePage(page, input({ steers: ['(once) x'] }));
    expect(next).toContain(
      '## In short\n\n- **Goal:** catch material change.\n',
    );
  });

  it('keeps answered comments in the instruction while the prompt is unchanged', () => {
    const page = buildDirectivePage(null, input()).replace(
      'a weekly change monitor.',
      'a weekly change monitor.{>> also subagents <<}{>> [author=claude] filed as a standing steer <<}',
    );
    const next = buildDirectivePage(
      page,
      input({
        steers: ['(standing) also cover subagents'],
        today: '2026-11-02',
      }),
    );
    expect(next).toContain(
      'monitor.{>> also subagents <<}{>> [author=claude] filed as a standing steer <<}',
    );
    expect(next).toContain('- (standing) also cover subagents');
    expect(next).toContain('copied: 2026-10-27');
  });

  it('recopies the instruction and its date when the prompt changes', () => {
    const page = buildDirectivePage(null, input());
    const next = buildDirectivePage(
      page,
      input({ prompt: 'You are Scout v1.', today: '2026-11-02' }),
    );
    expect(next).toContain('copied: 2026-11-02');
    expect(next.endsWith('You are Scout v1.\n')).toBe(true);
    expect(next).not.toContain('How to run');
  });
});

describe('refreshTaskDirective', () => {
  let vault: string;
  const dir = () => path.join(vault, 'Research Journal', 'Tasks', 'Scout');
  const file = () => path.join(dir(), '_Directive.md');
  const task = {
    id: 't-scout',
    prompt: PROMPT,
    schedule_type: 'cron' as const,
    schedule_value: '0 10 * * 1',
  };

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'task-directive-test-'));
  });

  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true });
  });

  it('writes the page with the steers from _Steering.md, then leaves it alone', () => {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(
      path.join(dir(), '_Steering.md'),
      '- [ ] (standing) drop topic 9 — from [[_Directive]], 2026-10-27\n',
    );
    expect(refreshTaskDirective(vault, 'Scout', task, '2026-10-27')).toBe(
      'written',
    );
    expect(fs.readFileSync(file(), 'utf-8')).toContain(
      '- (standing) drop topic 9',
    );
    expect(refreshTaskDirective(vault, 'Scout', task, '2026-11-02')).toBe(
      'unchanged',
    );
  });

  it('waits while the page has an owner comment with no reply', () => {
    refreshTaskDirective(vault, 'Scout', task, '2026-10-27');
    const commented = fs
      .readFileSync(file(), 'utf-8')
      .replace('change monitor.', 'change monitor.{>> drop topic 9 <<}');
    fs.writeFileSync(file(), commented);
    expect(
      refreshTaskDirective(
        vault,
        'Scout',
        { ...task, prompt: 'v1' },
        '2026-11-02',
      ),
    ).toBe('deferred');
    expect(fs.readFileSync(file(), 'utf-8')).toBe(commented);
  });
});
