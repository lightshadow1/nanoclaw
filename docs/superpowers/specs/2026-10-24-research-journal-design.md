# Research journal in the Obsidian vault

Date: 2026-10-24. Status: approved by the owner 2026-10-25.

## Intent

The owner wants to read NanoClaw's research in Obsidian, not in long Telegram messages, and to give feedback inline. Telegram is hard to read at length and can't be annotated. The vault syncs to the owner's laptop (and later phone) within about a second and supports inline comments.

So every Monday research run writes a full write-up into the vault, filed by source. Telegram gets one short digest. Comments the owner leaves in a write-up get an answer in the note within about two hours, and they steer the next Monday run.

The same change adds a rule for interactive chats: quick answers stay in Telegram; durable outputs become notes.

## Current state

- **Vault.** The owner's Obsidian vault lives on the live host (`will-mini-s`) at `~/vaults/notes`. It syncs to the laptop via Self-hosted LiveSync and is mounted read-write into the **main** group's containers at `/workspace/extra/notes`; this mount comes from main's `registered_groups.container_config`.
- **Vault rules.** On the live host, `groups/main/CLAUDE.md` has a "Notes Vault (Obsidian)" section outside the soul markers. It covers where the vault is, what the agent may edit, `Inbox/` for agent-made notes, and the CriticMarkup comment conventions. This section is **not** in the repo copy of that file.
- **Monday research.** Times are local (America/Toronto):

| Time | Task id | Prompt lives in | What it produces today |
|---|---|---|---|
| 09:00 | `soul-production-main` | code: `src/capabilities/soul/planning-prompts.ts` | Each active soul, main included, researches its topics, updates its wiki, and may insert one bet. It never messages the owner directly. |
| 09:00 | `task-1778899268392-3ejz43` (AI audit/observability scan) | DB row | A Telegram summary, sent only if something is significant |
| 10:00 | `task-1779934568728-ovail9` (Scout v0, 11 portfolio topics) | DB row | Updates `groups/main/scout/knowledge.md` (about 200 KB) and sends a Telegram summary of flags |
| 11:00 | `task-1780425013963-uscus6` (solo travel research) | DB row | A Telegram summary |

- **Souls.** Four are active: `travel-solo`, `agent-isolation`, `aws-agentcore-adoption` and `counsel`. `observability` is dormant. Each soul's wiki at `groups/<folder>/soul/wiki/` is the agent's private memory.
- **Curation pass.** `soul-wiki-curation-main` runs every 2 hours. Its host-side `beforeTaskRun` gate in `src/capabilities/soul/index.ts` starts a container only when there is uncurated memory.

## Goals

1. Every Monday research run writes a complete, readable write-up to the vault: one dated note per run, in a folder per source.
2. A weekly index note links that Monday's write-ups.
3. Telegram gets at most one short digest per Monday, and nothing on a fully quiet week.
4. An owner comment in a journal note gets a reply in the note within about 2 hours. The steer is recorded and the next Monday run applies it.
5. A comment marked urgent is acted on in that same 2-hour pass.
6. Interactive chats follow the chat-versus-note rule below.

## Non-goals

- Changing what each task researches. This includes merging overlapping tasks: the AI audit scan overlaps Scout and the agent-related souls, and the travel task overlaps the `travel-solo` soul.
- The near-real-time (about 15 s) in-note conversation channel.
- Setting up the phone, building a web UI, or changing the read-only ops dashboard.
- Backfilling past results or copying Scout's `knowledge.md` into the vault.

## Anti-goals (failure even if it technically works)

- More Monday Telegram messages than today, or a digest on a quiet week.
- The agent editing the owner's own notes outside `Research Journal/` and `Inbox/` without being asked.
- An owner comment ignored, or deleted without a reply.
- Vault bloat: raw logs, knowledge bases or soul wikis copied in wholesale.
- Containers spun up every 2 hours when there is nothing to answer.
- Journal notes that restate the soul wiki instead of reporting this week's findings.

## Design (decided with the owner)

### Layout

```
Notes/
├── Inbox/                         agent-made notes from chat
└── Research Journal/
    ├── 2026-10-26 Weekly.md       one index per Monday
    ├── Souls/
    │   ├── main/
    │   ├── agent-isolation/
    │   │   ├── _Steering.md       standing steers for this source
    │   │   └── 2026-10-26.md      one write-up per run
    │   ├── aws-agentcore-adoption/
    │   ├── counsel/
    │   └── travel-solo/
    └── Tasks/
        ├── Scout/
        ├── AI Audit Observability/
        └── Solo Travel Research/
```

Soul folders use the soul's folder id. A soul that is spawned later gets its own folder on its first production run.

### A write-up note

Frontmatter: `type: research-journal`, `source: <folder or task name>`, `run: YYYY-MM-DD`, `status: unread`, `flags: <count>`. The owner may change `status` to `read`.

Body:

1. The title, then a one-sentence bottom line ("2 flags, 9 topics quiet").
2. One section per finding, each covering what changed, why it matters to the owner, sources as links, and confidence.
3. "Following your steer", when steers applied: one line per steer saying what was done.
4. "Quiet this week": what was checked and found unchanged, with the places checked.

A source that had nothing still writes a short note, as proof it ran.

### Weekly index

`Research Journal/YYYY-MM-DD Weekly.md` has one line per source: a link to the write-up plus its bottom line. Failed or missing runs are listed as such.

### Telegram digest

One message after all of that Monday's sources have finished, about 8 lines at most:

```
Monday research — Oct 26
• Scout: 2 flags (PwnEscape escape, MCP spec change)
• Travel: Toronto–Hanoi CAD 1,640, Nov 19–Dec 9
• agent-isolation: 1 new bet proposed
• Quiet: AI audit scan, counsel
Full write-ups → Research Journal/2026-10-26 Weekly
```

- If every source is quiet and every run succeeded, nothing is sent.
- The four Monday tasks stop sending their own Telegram messages.
- Bets keep their existing flow: inserted by the production pass, published by the check-in.

### Feedback loop

1. **The owner comments** with CriticMarkup, `{>> … <<}`, optionally anchored to text with `{==…==}{>> … <<}`, anywhere in a note under `Research Journal/` or `Inbox/`.
2. **Pickup.** The `soul-wiki-curation-main` host gate also returns true when such a note contains an *unhandled owner comment*. An owner comment counts as handled when it is immediately followed by a reply of the form `{>> [author=claude] … <<}`. With no unhandled comments and no uncurated memory, no container starts.
3. **Handling, in that pass:**
   - Reply right after the comment with `{>> [author=claude] <what will happen> <<}`.
   - Record the steer in that source's `_Steering.md`, a plain list. It stays until the owner deletes it or the agent marks a one-off steer done.
   - Comments in `Inbox/` notes are handled like any other request on that note.
4. **Urgent comments** start with `!` (`{>> ! dig deeper now <<}`). The pass does the work now, within its runtime budget, and appends a dated "Follow-up" section to the note.
5. **The next run** reads its `_Steering.md` before researching, applies the steers, and lists what it did under "Following your steer".

### Chat-versus-note rule (interactive chats)

This rule is added to the "Notes Vault (Obsidian)" section of `groups/main/CLAUDE.md`.

| Stays in chat | Becomes a note in `Inbox/` |
|---|---|
| Quick answers, confirmations, back-and-forth, status | Anything the owner will come back to, edit or share: plans, research write-ups, specs, comparisons, checklists, drafts |
| | Anything longer than a phone screen or with structure (headings, tables) |
| | Anything the owner calls "save", "write up", "draft" or "note" |

- A new note gets frontmatter: `type`, `created`, `source: telegram`, `status: draft`.
- The chat reply is 1–2 lines: what was made, the note's name, and the next step.
- Follow-up edits go into the same note.
- Ad-hoc research requested in chat goes to `Inbox/`, not `Research Journal/`. The journal is for scheduled runs.

## Constraints

- **Main does all the writing.** Only main's containers have the vault mount and DB access, so every write happens in main containers. Scheduled tasks for main get the mount through main's `container_config`. Spawned souls have no containers.
- **Soul task prompts are code.** `upsertSoulTask` refreshes them at startup, so changing them needs a code change and a deploy to `will-mini-s`. The live working tree is dirty and behind origin, so deploy with a worktree build and overlay, as in the operator notes. The three user tasks are DB rows and are updated in place.
- **Vault path.** The host-side gate needs the vault path on the host, which today exists only in main's `container_config` (`~/vaults/notes`).
- **The gate must stay cheap.** It scans a small vault (about 15 notes now, about 6 new notes per week) and must never start a container just to look.
- **LiveSync propagates every write within about a second.** Write each note once per run, then make small edits. Never touch `.obsidian/` or `.livesync/`.
- **Profiles.** Soul tasks run as `soul-maintenance`, which has Read/Write/Edit and `send_message`. User tasks run as `full`. Urgent work inside the curation pass is bounded by `SOUL_DEFAULT_RUNTIME_MS`.
- **Outreach.** Bets stay the only *proactive* outreach. The digest replaces the existing Monday task messages rather than adding a channel. Quiet hours (10 PM – 7 AM) still apply.
- **Runtimes.** Last Monday, the 11:00 task finished at about 11:01 and Scout took about an hour. Runtimes vary, so the digest must wait for completion, not a clock time.

## Left to the builder

- How the digest is triggered (a separate task, chained after the last source, or host-side), as long as it waits for every source and sends at most one message.
- How the gate detects unhandled comments, and where the host learns the vault path.
- How the production pass emits one note per soul inside its existing run.
- Note-name collisions, index formatting, any extra frontmatter, and tests.

## Calls made without the owner (check these)

- Steers live in `_Steering.md` per source folder, visible and editable by the owner.
- A `!` prefix marks an urgent comment.
- Quiet sources still write a short dated note. A fully quiet, fully successful Monday sends no Telegram message.
- A failed or missing run counts as not quiet, so it appears in the index and triggers the digest.
- The digest mentions bets proposed that Monday. Bets are still published by the check-in.
- The digest doesn't consume the proactive budget, so a Monday bet can still go out. Today only `publish_bet` (`requestPublishBet`) records a proactive send; task messages through `send_message` never have.
- `run` dates and note names use local dates (America/Toronto), matching the cron schedules.
- Main's own research goes in `Souls/main/`. The dormant `observability` soul gets no folder until it wakes.
- Comment pickup covers `Research Journal/` and `Inbox/` only, never the owner's other notes.
- Start fresh on Monday 2026-10-26, with no backfill.
