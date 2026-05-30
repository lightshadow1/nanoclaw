// Static prompts for the planning + initiative tasks (Phase 4).
//
// Same architecture as curator-prompts.ts: prompts are stored once at task
// creation time and the container agent reads live data (DB, wiki, plan
// files) itself on each run. The host never invokes the LLM.

import {
  PROACTIVE_MAX_MESSAGES,
  PROACTIVE_MIN_GAP_MS,
  PROACTIVE_QUIET_END,
  PROACTIVE_QUIET_START,
} from './proactive-budget.js';
import {
  MIN_OUTREACH_MULTIPLIER,
  PROXIMAL_WINDOW_MIN,
} from './experiment-store.js';

// Render an integer hour (0-23) as a 12-hour clock string ("7 AM", "10 PM").
function formatHour(h: number): string {
  if (h === 0) return '12 AM';
  if (h === 12) return '12 PM';
  if (h < 12) return `${h} AM`;
  return `${h - 12} PM`;
}

export function buildMorningPlanPrompt(folder: string): string {
  return `You are generating your daily plan.

## Context

1. Read your wiki index: /workspace/group/soul/wiki/_index.md
2. Read tasks-and-projects.md for ongoing work.
3. Read people.md for context on who you interact with.
4. Check yesterday's archived plan (if it exists):
   ls /workspace/group/soul/plan-history/ | tail -1
   Read that file if found.
5. Check for pending interventions across ALL active souls (main + spawned):
   sqlite3 /workspace/project/store/messages.db "SELECT id, content, metadata, group_folder FROM memory_stream WHERE (group_folder = '${folder}' OR group_folder IN (SELECT folder FROM souls WHERE state = 'active')) AND type = 'intervention' AND json_extract(metadata, '\$.status') = 'pending' ORDER BY timestamp DESC LIMIT 15"
   Interventions originating from a spawned soul carry a different group_folder than '${folder}' — attribute them to their soul of origin when you surface them. The shared proactive budget still caps the day at the main channel's limit (no multiplication per soul).
   One special intervention type to know about: \`spawn_soul\` — surfaces a proposal to spawn a dedicated soul for a topic. Carries proposed_folder / proposed_agent_name / proposed_topic_keywords. The owner's reply (resolved + approved=true) triggers host-side spawnSoul on the next morning-plan pass; this prompt only surfaces it.
6. Read your experiment state: /workspace/group/soul/experiment-state.json
   This is refreshed by the host before each run and carries:
   - \`timing.thompson_ranking\` — arms in preference order (best first) for today
   - \`recent_episodes\` — outcomes of recent proactive messages, verbatim
   - \`backoff\` — per-target outreach multipliers (frequency weights)
   - \`withdrawal_week\` — when true, emit ZERO outreach items today
   - \`efficacy_trailing_7d\` — recent success rate

## Plan Generation

Based on your wiki knowledge, yesterday's outcomes, recent episodes, and pending items, generate today's plan. Reason explicitly over the recent episodes in \`notes\` — e.g. "evening check-ins to Alice have landed well; afternoon ones got ignored — shifting toward evening".

Write the plan to /workspace/group/soul/daily-plan.json with this structure:

\`\`\`json
{
  "date": "YYYY-MM-DD",
  "generated_at": "ISO timestamp",
  "items": [
    {
      "id": "plan-item-uuid",
      "description": "What to do",
      "type": "check_in | follow_up | reminder | project_work | social",
      "priority": "high | medium | low",
      "target": "person or group name (optional)",
      "channel": "whatsapp | telegram (optional)",
      "time_hint": "morning | afternoon | evening (optional)",
      "status": "pending"
    }
  ],
  "notes": "Brief reasoning about today's priorities; include episode-based reasoning."
}
\`\`\`

## Rules

- Maximum 5 items per day. Quality over quantity.
- At most 2 items should be proactive outreach (check_in or social type).
- Never plan messages between ${formatHour(PROACTIVE_QUIET_START)} and ${formatHour(PROACTIVE_QUIET_END)}.
- Only plan outreach to people/groups you have conversed with before (check people.md).
- If yesterday's plan had uncompleted items, carry forward only if still relevant.
- Include at least one "project_work" item if tasks-and-projects.md has active projects.

## Timing (Thompson-sampled)

- For every outreach item (\`check_in\` / \`follow_up\` / \`social\`), set \`time_hint\` from \`experiment-state.json.timing.thompson_ranking\` (prefer rank 1; spread across ranks if you have several outreach items).
- Do NOT roll your own dice for timing — the host already drew today's ranking.

## Backoff (self-adjustment within guardrails)

- Read \`experiment-state.json.backoff[target].outreach_multiplier\` for each prospective target. A lower multiplier ⇒ fewer outreach items for that target this cycle. Multiplier is a frequency weight, not a hard cap.
- If a target's recent episodes are mostly failures (ignored / negative-sentiment replies), LOWER their multiplier and write the updated backoff state back to the experiment_tuning table:
  sqlite3 /workspace/project/store/messages.db "UPDATE experiment_tuning SET state_json = json_set(state_json, '$.targets.<TARGET>.outreach_multiplier', <NEW_VALUE>) WHERE group_folder = '${folder}' AND active = 1"
- Multipliers must stay in [${MIN_OUTREACH_MULTIPLIER}, 1.0]. The host clamps anything outside on the next read; do not waste prompt budget on 0.0 — it is NOT an allowed autonomous action.
- To stop outreach to a target entirely you MUST raise an intervention (see Creating Interventions in the check-in prompt) and wait for owner approval. You may not autonomously pause.

## Withdrawal Week

- If \`experiment-state.json.withdrawal_week\` is true, emit ZERO outreach items (no \`check_in\` / \`follow_up\` / \`social\`). \`project_work\` and \`reminder\` items are still allowed. Note the withdrawal explicitly in \`notes\` (e.g. "withdrawal week — no proactive outreach planned").

## Output

After writing daily-plan.json, output a brief 1-2 sentence summary of today's priorities. If nothing is planned (quiet day), wrap in <internal>...</internal>.
`;
}

export function buildCheckInPrompt(folder: string): string {
  return `You are performing a plan check-in.

## Step 0 — Evaluate pending experiments (BEFORE any new outreach)

1. Read today's plan: /workspace/group/soul/daily-plan.json
   For each item with status "sent" whose sent_at is more than ${PROXIMAL_WINDOW_MIN} minutes ago:

   a. Query the owner's replies in the proximal window:
      sqlite3 /workspace/project/store/messages.db "SELECT content, timestamp FROM memory_stream WHERE group_folder = '${folder}' AND type = 'observation' AND timestamp > '<SENT_AT>' AND timestamp <= datetime('<SENT_AT>', '+${PROXIMAL_WINDOW_MIN} minutes') ORDER BY timestamp ASC"

   b. Determine the outcome:
      - No rows  → outcome = 'ignored', sentiment = NULL
      - Rows     → outcome = 'replied'. Classify the SENTIMENT OF THE OWNER'S REPLY TEXT as 'positive' | 'neutral' | 'negative'. You are judging the OWNER'S words, NOT your own message. Do not flatter yourself.

   c. Insert an immutable episode row:
      sqlite3 /workspace/project/store/messages.db "INSERT INTO experiment_episodes (id, group_folder, plan_item_id, target, timing_arm, sent_at, message_excerpt, outcome, sentiment, proximal_window_min, created_at) VALUES (lower(hex(randomblob(16))), '${folder}', '<PLAN_ITEM_ID>', '<TARGET>', '<TIMING_ARM>', '<SENT_AT>', '<MESSAGE_EXCERPT_FIRST_200_CHARS>', '<OUTCOME>', <SENTIMENT_OR_NULL>, ${PROXIMAL_WINDOW_MIN}, datetime('now'))"

   d. Set the plan item's status from "sent" → "done" in daily-plan.json.

## Step 1 — Check budget and withdrawal status

1. Read your experiment state: /workspace/group/soul/experiment-state.json
   If \`withdrawal_week\` is true, SKIP all proactive sending below (Step 0 evaluation still runs). Output <internal>Withdrawal week — evaluation only.</internal> and exit.

2. Read today's plan (already loaded above).
   If it doesn't exist, output <internal>No plan for today.</internal> and exit.

3. Read the proactive budget: /workspace/group/soul/proactive-budget.json
   If it doesn't exist, create it:
   {"date": "YYYY-MM-DD", "messages_sent": 0, "last_message_at": null}

4. Check if the budget allows a proactive message:
   - Maximum ${PROACTIVE_MAX_MESSAGES} proactive messages per day
   - Minimum ${PROACTIVE_MIN_GAP_MS / 3_600_000} hours since the last proactive message
   - Current time must be between ${formatHour(PROACTIVE_QUIET_END)} and ${formatHour(PROACTIVE_QUIET_START)} (run \`date\` to check)
   If any condition fails, skip proactive messaging entirely.

## Step 2 — Send and record (proactive items)

5. Look at plan items with status "pending" and time_hint matching current time of day:
   - ${formatHour(PROACTIVE_QUIET_END)} – 12 PM = "morning"
   - 12 PM – 5 PM = "afternoon"
   - 5 PM – ${formatHour(PROACTIVE_QUIET_START)} = "evening"

6. For each actionable item in this time window:
   a. If type is "check_in", "follow_up", or "social":
      - Compose a natural message (NOT "SYSTEM: Scheduled check-in" — write like a person).
      - Send via: mcp__nanoclaw__send_message with the target JID.
      - Update proactive-budget.json (increment messages_sent, update last_message_at).
      - In daily-plan.json, set the item's status to "sent" (NOT "done") and record:
        - "sent_at": ISO timestamp of the send
        - "timing_arm": the current time-of-day bucket ("morning" | "afternoon" | "evening")
        - "message_excerpt": first ~200 chars of the message you sent
        The next check-in's Step 0 will evaluate it and flip "sent" → "done".
   b. If type is "reminder":
      - Send the reminder message to the target.
      - Mark as done (reminders are not experiments — no episode row).
   c. If type is "project_work":
      - Check if there's progress to report (look at recent memory_stream entries).
      - If yes, update tasks-and-projects.md wiki page.
      - Mark as done or keep pending if ongoing.

7. If you sent any messages, output a brief note of what you did.
   Otherwise, output <internal>Nothing actionable this check-in.</internal>

## Proactive Message Style

- Be warm and natural. Reference specific context from your wiki.
- Never reveal you're following a plan ("my schedule says to check in with you" — NO).
- Good: "Hey, how did that presentation go yesterday?"
- Good: "Quick thought on the API issue — did the retry fix work?"
- Bad: "This is your scheduled check-in message."
- Bad: "According to my plan, I should ask you about..."

## Guard Rails

- NEVER send to a JID not in people.md
- NEVER exceed the daily budget (${PROACTIVE_MAX_MESSAGES} messages)
- NEVER message during quiet hours (${formatHour(PROACTIVE_QUIET_START)} – ${formatHour(PROACTIVE_QUIET_END)})
- NEVER send proactive messages during a withdrawal week (\`experiment-state.json.withdrawal_week\` is the truth)
- If uncertain whether a message is appropriate, create an intervention instead (see below).

## Creating Interventions

If you encounter a situation needing human input:
sqlite3 /workspace/project/store/messages.db "INSERT INTO memory_stream (id, group_folder, timestamp, type, source, content, importance, metadata, curated) VALUES (lower(hex(randomblob(16))), '${folder}', datetime('now'), 'intervention', 'agent', 'question text here', 8, json('{\\"intervention_type\\":\\"approval_needed\\",\\"question\\":\\"...\\",\\"context\\":\\"...\\",\\"options\\":[\\"...\\"],\\"priority\\":\\"medium\\",\\"status\\":\\"pending\\"}'), 0)"

Then send the question to the owner via send_message.
`;
}
