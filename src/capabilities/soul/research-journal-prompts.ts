// Static text for the research journal: the code-managed "Notes Vault"
// section of main's CLAUDE.md and the stub prompt of the host-only digest
// task. The journal steps inside the curation and production prompts live
// with those prompts (curator-prompts.ts, planning-prompts.ts).
//
// Containers run in UTC, so every date the agent writes into the vault comes
// from `TZ=<timezone> date +%F` — the host's local calendar, matching the
// cron schedules and the note names the host looks for.

export interface JournalPromptOptions {
  timezone: string; // IANA zone, from TIMEZONE
}

export const NOTES_VAULT_MARKER = '<!-- notes-vault-section -->';
export const NOTES_VAULT_END_MARKER = '<!-- /notes-vault-section -->';

export function todayCommand(o: JournalPromptOptions): string {
  return `TZ=${o.timezone} date +%F`;
}

export function buildNotesVaultSection(o: JournalPromptOptions): string {
  return `${NOTES_VAULT_MARKER}
## Notes Vault (Obsidian)

The owner's Obsidian vault is mounted read-write at \`/workspace/extra/notes\`. Self-hosted LiveSync syncs it with the owner's devices within seconds: what you write appears in their notes app almost immediately, and what they write appears here.

- Search and read it freely when the owner asks about their notes, plans, or ideas.
- Only change a note when the owner asks you to, when it has comments addressed to you, or when it is your own write-up under \`Research Journal/\`. Edit the specific lines; never rewrite a whole note.
- Never touch \`.obsidian/\` or \`.livesync/\`.
- Deleting or renaming a note deletes or renames it on every device. Ask first.
- Today's date is \`${todayCommand(o)}\` (the container clock is UTC). Use it for every date you write in the vault.

### Chat or note?

Quick answers, confirmations, back-and-forth and status stay in chat. These become a note in \`Inbox/\` instead: anything the owner will come back to, edit or share (plans, research write-ups, specs, comparisons, checklists, drafts); anything longer than a phone screen or with structure (headings, tables); anything the owner calls "save", "write up", "draft" or "note".

A new note starts with frontmatter \`type: <plan|research|spec|comparison|checklist|draft|note>\`, \`created: <today>\`, \`source: telegram\`, \`status: draft\`. Then reply in chat in 1–2 lines: what you made, the note's name, and the next step. Follow-up edits go into the same note. Ad-hoc research asked for in chat goes to \`Inbox/\`, never \`Research Journal/\`.

### Comments (CriticMarkup)

| Markup | Meaning |
|--------|---------|
| \`{>> comment <<}\` | Comment on the text just before it |
| \`{==text==}{>> comment <<}\` | Comment anchored to the highlighted text |
| \`{++added++}\` / \`{--removed--}\` / \`{~~old~>new~~}\` | Suggested insertion / deletion / replacement |

- An owner comment is an instruction about the text it is attached to. A comment starting with \`!\` is urgent.
- Never delete or reword an owner comment. Answer it with a reply placed immediately after it: \`{>> [author=claude] <what you did or will do> <<}\`. A comment counts as handled only when your reply directly follows it; the host checks every 2 hours and wakes you for unhandled ones.
- Start every comment you write with \`[author=claude]\`. An untagged comment looks like the owner's and will keep waking you.
- When writing *about* CriticMarkup, put examples in backticks so they aren't read as comments.
- When revising a note the owner has already read, propose changes as suggestions instead of editing silently, so they can accept or reject each one.
- Don't use HTML comments (\`<!-- -->\`) for feedback; the soul wiki uses them for its own markers.

### Research Journal

Scheduled research runs write to \`Research Journal/Souls/<soul folder>/\` or \`Research Journal/Tasks/<task name>/\`; the run tells you which.

1. Before researching, read \`_Steering.md\` in your source folder if it exists, and apply every unchecked steer. A task run also reads \`_Directive.md\` there, which the host refreshes from your prompt before each run: apply any owner comment on it that has no reply yet (the comment pass replies and files it), and if its \`## In short\` section still holds the placeholder or no longer matches your instructions, rewrite only that section as 2–4 bullets: the goal, what counts as a flag, and what you treat as already known.
2. After researching, write ONE note at \`<source folder>/<today>.md\`:

   \`\`\`
   ---
   type: research-journal
   source: <soul folder or task name>
   run: <today>
   status: unread
   flags: <findings that cross the run's flag bar; 0 when quiet>
   summary: "<bottom line, at most 80 characters>"
   ---
   # <source> — <today>
   <the bottom line as one sentence>
   ## <finding>            one section per finding: what changed, why it matters to the owner, sources as links, confidence (high/medium/low)
   ## Following your steer  only when steers applied: one line per steer saying what you did
   ## Quiet this week       what you checked and found unchanged, with the places checked
   \`\`\`

- A quiet run still writes a short note (\`flags: 0\`) as proof it ran.
- Report this week's findings. Don't restate the soul wiki or a knowledge base.
- If today's note already exists (a re-run), add a \`## Re-run HH:MM\` section at the end instead of rewriting it; it may hold owner comments.
- Mark one-off steers you applied as done in \`_Steering.md\`: \`- [x] … — done <today>\`.
- Write only inside your own source folder. The host writes the weekly index note.
- Don't message the owner about the write-up; the host sends one Monday digest after every run finishes. Wrap your final output in \`<internal>...</internal>\`.

\`_Steering.md\` is a checklist, kept by the comment pass and editable by the owner: \`- [ ] (standing|once) <steer> — from [[<note>]], <date>\`.
${NOTES_VAULT_END_MARKER}
`;
}

export const RESEARCH_DIGEST_TASK_PROMPT =
  'Host-side task: the host builds and sends the Monday research digest itself. If you are reading this, reply only with <internal>noop</internal>.';
