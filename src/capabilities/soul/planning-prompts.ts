// Static prompts for the planning + initiative tasks (Phase 4).
//
// Same architecture as curator-prompts.ts: prompts are stored once at task
// creation time and the container agent reads live data (DB, wiki, plan
// files) itself on each run. The host never invokes the LLM.

export function buildMorningPlanPrompt(folder: string): string {
  return `You are generating your daily plan.

## Context

1. Read your wiki index: /workspace/group/soul/wiki/_index.md
2. Read tasks-and-projects.md for ongoing work.
3. Read people.md for context on who you interact with.
4. Check yesterday's archived plan (if it exists):
   ls /workspace/group/soul/plan-history/ | tail -1
   Read that file if found.
5. Check for pending interventions:
   sqlite3 /workspace/project/store/messages.db "SELECT id, content, metadata FROM memory_stream WHERE group_folder = '${folder}' AND type = 'intervention' AND json_extract(metadata, '$.status') = 'pending' ORDER BY timestamp DESC LIMIT 10"

## Plan Generation

Based on your wiki knowledge, yesterday's outcomes, and pending items, generate today's plan.

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
  "notes": "Brief reasoning about today's priorities"
}
\`\`\`

## Rules

- Maximum 5 items per day. Quality over quantity.
- At most 2 items should be proactive outreach (check_in or social type).
- Never plan messages between 10 PM and 7 AM.
- Only plan outreach to people/groups you have conversed with before (check people.md).
- If yesterday's plan had uncompleted items, carry forward only if still relevant.
- Include at least one "project_work" item if tasks-and-projects.md has active projects.

## Output

After writing daily-plan.json, output a brief 1-2 sentence summary of today's priorities. If nothing is planned (quiet day), wrap in <internal>...</internal>.
`;
}

export function buildCheckInPrompt(folder: string): string {
  return `You are performing a plan check-in.

## Instructions

1. Read today's plan: /workspace/group/soul/daily-plan.json
   If it doesn't exist, output <internal>No plan for today.</internal> and exit.

2. Read the proactive budget: /workspace/group/soul/proactive-budget.json
   If it doesn't exist, create it:
   {"date": "YYYY-MM-DD", "messages_sent": 0, "last_message_at": null}

3. Check if the budget allows a proactive message:
   - Maximum 3 proactive messages per day
   - Minimum 2 hours since the last proactive message
   - Current time must be between 7 AM and 10 PM (run \`date\` to check)
   If any condition fails, skip proactive messaging entirely.

4. Look at plan items with status "pending" and time_hint matching current time of day:
   - 7 AM – 12 PM = "morning"
   - 12 PM – 5 PM = "afternoon"
   - 5 PM – 10 PM = "evening"

5. For each actionable item in this time window:
   a. If type is "check_in", "follow_up", or "social":
      - Compose a natural message (NOT "SYSTEM: Scheduled check-in" — write like a person).
      - Send via: mcp__nanoclaw__send_message with the target JID.
      - Update proactive-budget.json (increment messages_sent, update last_message_at).
      - Update the item's status to "done" in daily-plan.json.
   b. If type is "reminder":
      - Send the reminder message to the target.
      - Mark as done.
   c. If type is "project_work":
      - Check if there's progress to report (look at recent memory_stream entries).
      - If yes, update tasks-and-projects.md wiki page.
      - Mark as done or keep pending if ongoing.

6. If you sent any messages, output a brief note of what you did.
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
- NEVER exceed the daily budget (3 messages)
- NEVER message during quiet hours (10 PM – 7 AM)
- If uncertain whether a message is appropriate, create an intervention instead (see below).

## Creating Interventions

If you encounter a situation needing human input:
sqlite3 /workspace/project/store/messages.db "INSERT INTO memory_stream (id, group_folder, timestamp, type, source, content, importance, metadata, curated) VALUES (lower(hex(randomblob(16))), '${folder}', datetime('now'), 'intervention', 'agent', 'question text here', 8, json('{\\"intervention_type\\":\\"approval_needed\\",\\"question\\":\\"...\\",\\"context\\":\\"...\\",\\"options\\":[\\"...\\"],\\"priority\\":\\"medium\\",\\"status\\":\\"pending\\"}'), 0)"

Then send the question to the owner via send_message.
`;
}
