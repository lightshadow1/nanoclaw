// Static prompts for the planning + initiative tasks (Phase 6: bet ledger).
//
// Same architecture as curator-prompts.ts: prompts are stored once at task
// creation time and the container agent reads live data (DB, wiki, plan
// files) itself on each run. The host never invokes the LLM.
//
// Phase 6 design principles (see BET_LEDGER_PROMPT.md):
// - Owner silence is the noise baseline, not a signal. Never narrate quiet
//   days; the correct output on most days is nothing.
// - The only sanctioned proactive outreach (besides reminders) is a BET: a
//   decision-ready finding with a recommendation, pros/cons, and a concrete
//   next action. Digests don't clear the bar.
// - Outcomes are measured on a days timescale by ground truth (button taps,
//   reactions, topic references, 7-day timeout) — not by reply-within-90min.

import {
  PROACTIVE_MAX_MESSAGES,
  PROACTIVE_QUIET_END,
  PROACTIVE_QUIET_START,
} from './proactive-budget.js';
import { BET_WINDOW_DAYS, MAX_OPEN_BETS } from './bet-store.js';

// Render an integer hour (0-23) as a 12-hour clock string ("7 AM", "10 PM").
function formatHour(h: number): string {
  if (h === 0) return '12 AM';
  if (h === 12) return '12 PM';
  if (h < 12) return `${h} AM`;
  return `${h - 12} PM`;
}

export function buildMorningPlanPrompt(folder: string): string {
  return `You are doing your morning ledger maintenance. Keep it short — this
is bookkeeping, not an essay.

## Review

1. Open bets:
   sqlite3 /workspace/project/store/messages.db "SELECT id, group_folder, title, status, sent_at FROM bets WHERE status IN ('proposed', 'sent') ORDER BY created_at ASC"
   If a 'proposed' bet is clearly no longer relevant (overtaken by events,
   owner already decided), retract it:
   sqlite3 /workspace/project/store/messages.db "UPDATE bets SET status = 'retracted' WHERE id = '<ID>' AND status = 'proposed'"

2. Pending interventions across all active souls:
   sqlite3 /workspace/project/store/messages.db "SELECT id, content, metadata, group_folder FROM memory_stream WHERE (group_folder = '${folder}' OR group_folder IN (SELECT folder FROM souls WHERE state = 'active')) AND type = 'intervention' AND json_extract(metadata, '\$.status') = 'pending' ORDER BY timestamp DESC LIMIT 15"
   One special intervention type: \`spawn_soul\` — a proposal to spawn a
   dedicated soul. Carries proposed_folder / proposed_agent_name /
   proposed_topic_keywords. The owner's reply (resolved + approved=true)
   triggers host-side spawnSoul on the next morning pass; you only surface it.

3. Read tasks-and-projects.md in your wiki for anything with a date today.

## Plan

Write /workspace/group/soul/daily-plan.json:

\`\`\`json
{
  "date": "YYYY-MM-DD",
  "generated_at": "ISO timestamp",
  "items": [
    {
      "id": "plan-item-uuid",
      "description": "What to do",
      "type": "reminder | project_work",
      "priority": "high | medium | low",
      "status": "pending"
    }
  ],
  "notes": "At most 2 factual sentences. No narration of quiet days, no engagement analysis."
}
\`\`\`

## Rules

- Items are ONLY "reminder" (owner asked to be reminded of something
  concrete) or "project_work" (background work on an active project).
  Maximum 3 items. Zero items is a normal, healthy plan.
- NO outreach items. Proactive outreach happens exclusively through bets,
  which the check-in task publishes from the bets table.
- Owner silence is the baseline, not a pattern to analyze. Do not count
  quiet days, do not infer "owner wants space", do not write paragraphs
  about engagement.

## Output

1-2 sentences max. If nothing needs the owner's attention, wrap the whole
output in <internal>...</internal>.
`;
}

export function buildCheckInPrompt(folder: string): string {
  return `You are doing a bet-ledger check-in.

## Step 0 — Resolve sent bets by reference

1. List bets awaiting a response:
   sqlite3 /workspace/project/store/messages.db "SELECT id, group_folder, title, body, sent_at FROM bets WHERE status = 'sent'"

2. For each, check whether the owner has engaged with the TOPIC since it was
   sent (button taps are handled by the host — you are only looking for the
   owner talking about it in chat):
   sqlite3 /workspace/project/store/messages.db "SELECT content, timestamp FROM memory_stream WHERE group_folder = '${folder}' AND type = 'observation' AND timestamp > '<SENT_AT>' ORDER BY timestamp ASC LIMIT 30"
   If the owner's own words clearly engage the bet's subject (mentions it,
   acts on it, asks about it), resolve it:
   sqlite3 /workspace/project/store/messages.db "UPDATE bets SET status = 'resolved', resolution = 'referenced', resolution_source = 'reference', resolved_at = datetime('now') WHERE id = '<ID>' AND status = 'sent'"
   Be strict: a vague thematic overlap is NOT a reference. When unsure,
   leave it — the ${BET_WINDOW_DAYS}-day timeout handles it, and a timeout is
   a valid label (the noise baseline at work), not a failure.

## Step 1 — Guardrails

3. Run \`date\` to check the time. Between ${formatHour(PROACTIVE_QUIET_START)} and ${formatHour(PROACTIVE_QUIET_END)} (quiet
   hours), do Step 0 only, then stop.
4. Read /workspace/group/soul/proactive-budget.json. If \`messages_sent\` >=
   ${PROACTIVE_MAX_MESSAGES} today, skip Step 2 (reminders in Step 3 are still allowed).
   Do NOT edit this file for bets — the host updates it when it publishes.

## Step 2 — Publish at most ONE bet

5. sqlite3 /workspace/project/store/messages.db "SELECT id, group_folder, title, recommendation FROM bets WHERE status = 'proposed' ORDER BY created_at ASC"
6. If there are none, skip this step. NEVER compose ad-hoc proactive
   messages — a bet in the table is the only sanctioned outreach.
7. Pick the single most decision-ready one (a clear recommendation the owner
   can act on today beats an older but vaguer one). Sanity-check it is still
   relevant; if not, retract it (UPDATE ... SET status = 'retracted') and
   consider the next.
8. Publish it with the publish_bet tool: mcp__nanoclaw__publish_bet with
   bet_id. The HOST formats the message, attaches the response buttons,
   stamps sent_at, and consumes the proactive budget. Do not also send the
   bet text via send_message — that would double-post.

## Step 3 — Reminders

9. Read /workspace/group/soul/daily-plan.json (if it exists). For each item
   with type "reminder" and status "pending" whose moment has come: send it
   via mcp__nanoclaw__send_message (write like a person, not "SYSTEM:
   reminder"), then set its status to "done" in the file.

## Blog drafts (owner tapped "Draft it")

Some bets are blog candidates (title starts "📝 Blog:"). When the owner acts on one, they want WRITING MATERIAL — not a finished post.

1. List blog candidates the owner chose to draft:
   sqlite3 /workspace/project/store/messages.db "SELECT id, title, body FROM bets WHERE status='resolved' AND resolution='acted' AND title LIKE '📝 Blog:%' ORDER BY resolved_at DESC"

2. For EACH such bet, check whether it's already been delivered:
   ls /workspace/group/scout/drafts/<bet_id>.md
   If the file exists, SKIP it — already delivered. Never re-send.

3. For a bet with no draft file yet, assemble a markdown brief. Read the topic's section in /workspace/group/scout/knowledge.md for the verified facts and source URLs. Structure the file as:
   - Title + the bet's framing (one line).
   - "## What changed" — the facts Scout has, each with its source URL.
   - "## Angle options" — 2-3 distinct framings (from-the-inside tie to your own build / contrarian read / mistake-before-solution arc).
   - "## Scaffold" — a skeleton in the vulnerable-expertise voice: Dev Notes opener → mistakes-before-solutions arc → open-question ending. Each section is a PROMPT to the writer ("what did you get wrong first here?"), not finished prose.
   - "## VERIFY BEFORE PUBLISHING" — an explicit checklist of every claim to confirm against primary sources before publishing (CVE numbers, dates, attributions). This brief is NOT verified.

4. Write the file to /workspace/group/scout/drafts/<bet_id>.md (create the drafts/ dir if needed), THEN deliver it with the send_document tool:
   send_document(filename: "<slug>.md", content: "<the full markdown>", caption: "📝 Draft material: <short title>")

5. Do this for at most 2 drafts per run. Writing the file AND calling send_document both matter — the file is the delivered-marker that prevents re-sending.

## Interventions

If something needs the owner's decision (approval, ambiguity, cost), store an
intervention and ask:
sqlite3 /workspace/project/store/messages.db "INSERT INTO memory_stream (id, group_folder, timestamp, type, source, content, importance, metadata, curated) VALUES (lower(hex(randomblob(16))), '${folder}', datetime('now'), 'intervention', 'agent', 'question text here', 8, json('{\\"intervention_type\\":\\"approval_needed\\",\\"question\\":\\"...\\",\\"context\\":\\"...\\",\\"options\\":[\\"...\\"],\\"priority\\":\\"medium\\",\\"status\\":\\"pending\\"}'), 0)"
Then send the question via send_message.

## Output

If you published or sent something, say what in one sentence. Otherwise wrap
your output in <internal>...</internal>. Quiet check-ins are the norm.
`;
}

export function buildProductionPrompt(folder: string): string {
  return `You are doing the weekly production pass: each soul gets one chance
to turn its accumulated knowledge plus fresh research into AT MOST ONE bet —
a decision-ready finding worth interrupting the owner for.

## The bar

A bet must contain ALL of:
- a specific, current finding (not a digest, not "here's what's new");
- a recommendation with explicit pros/cons;
- a concrete next action the owner could take this week.
If a soul's domain produced nothing that clears this bar, produce NOTHING for
it. A quiet week is the normal, correct outcome — do not lower the bar to
have something to show.

## Learn from past resolutions first

sqlite3 /workspace/project/store/messages.db "SELECT group_folder, title, resolution FROM bets WHERE status IN ('resolved', 'expired') ORDER BY resolved_at DESC LIMIT 10"
'acted'/'referenced' tell you what kind of content the owner values;
'rejected'/'expired' tell you what missed. Shape this week's bets accordingly.

## Per-soul pass

1. List the souls:
   sqlite3 /workspace/project/store/messages.db "SELECT folder, agent_name, spawn_reason FROM souls WHERE state = 'active'"
   Also include yourself ('${folder}') for owner-level projects in your own
   tasks-and-projects.md.

2. Check capacity:
   sqlite3 /workspace/project/store/messages.db "SELECT group_folder, COUNT(*) FROM bets WHERE status IN ('proposed', 'sent') GROUP BY group_folder"
   - Skip any soul that already has an open (proposed or sent) bet.
   - Global cap: if ${MAX_OPEN_BETS} or more bets are open in total, stop —
     ledger is full.

3. For EACH remaining soul (its folder below is SOUL):
   a. Read its wiki: /workspace/project/groups/SOUL/soul/wiki/_index.md and
      the pages relevant to its spawn_reason. (Your own wiki is at
      /workspace/group/soul/wiki/.)
   b. Research the domain with your available tools (web search, browser).
      You are looking for developments since the wiki's last_confirmed dates
      that change a decision the owner faces.
   c. Update that soul's wiki with what you learned (same rules as curation:
      rewrite sections, refresh <!-- last_confirmed: YYYY-MM-DD -->, prune).
   d. If — and only if — something clears the bar, insert ONE bet. Use single
      quotes doubled ('') to escape any quotes inside text:
      sqlite3 /workspace/project/store/messages.db "INSERT INTO bets (id, group_folder, title, body, recommendation, prediction, status, created_at, window_days) VALUES (lower(hex(randomblob(16))), 'SOUL', '<TITLE max ~80 chars>', '<BODY: the finding + pros/cons + concrete action, a few short paragraphs>', '<RECOMMENDATION: one sentence>', '<PREDICTION: what you expect the owner to do with it>', 'proposed', datetime('now'), ${BET_WINDOW_DAYS})"
      The check-in task publishes it later — do NOT send it to the chat
      yourself, and do not publish more than the single best bet per soul.

## Output

<internal>One line per soul: bet proposed (title) or nothing cleared the
bar.</internal> This pass never messages the owner directly.
`;
}
