// Static prompts for the soul's scheduled curation tasks.
//
// Per the architecture decision in WIKI_CURATION_PROMPT.md, these prompts
// are stored once at task creation time and the container agent reads live
// data (DB rows, wiki files) itself on each run. The host never builds a
// per-run prompt and never calls the LLM directly.

export function buildWikiCurationPrompt(folder: string): string {
  return `You are performing a wiki curation pass. You are the MAIN soul, and
you are the only soul with database access — so you curate BOTH your own
memory AND the memory of every spawned soul into their wikis.

# Part 1 — Curate your own (main) memory

1. Query your uncurated memory entries:
   sqlite3 /workspace/project/store/messages.db "SELECT id, timestamp, type, source, content, importance FROM memory_stream WHERE group_folder = '${folder}' AND curated = 0 ORDER BY timestamp ASC LIMIT 50"

2. If there are no uncurated entries, or every returned row has importance <= 2, skip to Part 2 without writing your own wiki and without running the curated UPDATE for yourself.

3. Read your wiki index at /workspace/group/soul/wiki/_index.md and list the directory to see what pages exist.

4. Load the wiki pages most relevant to the uncurated entries (people.md if names appear, preferences.md for preference words like prefer/like/hate/always/never, learnings.md for insight words like learned/realized/discovered, plus any topic-named pages whose keywords appear in the entries). Cap at 5 pages.

5. For each entry with importance >= 3, decide:
   - New information about a person -> update people.md
   - A preference -> update preferences.md
   - An insight or generalization -> update learnings.md
   - Relates to an ongoing project or task -> update tasks-and-projects.md (create if missing)
   - A new topic that doesn't fit -> create a new page (alphanumeric + hyphens + .md only)
   - Mundane -> skip it

6. When updating a page:
   - REWRITE the relevant section, do not append.
   - Merge new info with existing content.
   - Remove anything now contradicted or outdated.
   - After each section, add or refresh a marker: <!-- last_confirmed: YYYY-MM-DD --> using today's date (run \`date -u +%Y-%m-%d\` to get it).

7. Staleness: any section whose <!-- last_confirmed --> is older than 14 days with no new supporting evidence -> move it under an "Unconfirmed" heading at the bottom of the page, or delete if trivial.

8. Pruning: the wiki should get BETTER, not BIGGER. Replace contradicted info. Remove irrelevant detail.

9. Update _index.md only if you created, deleted, or significantly changed a page.

10. Mark your processed entries as curated (include skipped ones too — they're done):
    sqlite3 /workspace/project/store/messages.db "UPDATE memory_stream SET curated = 1 WHERE id IN ('id1','id2',...)"

# Part 2 — Curate each spawned soul's memory

Spawned souls have their own wikis but no database access, so you curate
them. Their observations were routed into their memory_stream by the host.

11. List the active spawned souls:
    sqlite3 /workspace/project/store/messages.db "SELECT folder, agent_name, spawn_reason FROM souls WHERE state = 'active' AND folder != '${folder}'"

12. For EACH spawned soul (call its folder SOUL):
    a. Query its uncurated entries:
       sqlite3 /workspace/project/store/messages.db "SELECT id, timestamp, type, source, content, importance FROM memory_stream WHERE group_folder = 'SOUL' AND curated = 0 ORDER BY timestamp ASC LIMIT 50"
    b. If there are none, or every row has importance <= 2, skip this soul (do not write its wiki, do not run its curated UPDATE).
    c. That soul's wiki lives at /workspace/project/groups/SOUL/soul/wiki/ — read its _index.md and list the directory.
    d. Apply the SAME curation rules as steps 4-9 above, but write into /workspace/project/groups/SOUL/soul/wiki/ and keep strictly within THAT soul's domain (its spawn_reason). Do not mix one soul's knowledge into another's wiki, and do not put spawned-soul content into your own wiki.
    e. Mark that soul's processed entries curated:
       sqlite3 /workspace/project/store/messages.db "UPDATE memory_stream SET curated = 1 WHERE id IN ('id1','id2',...)"

# Output

13. Output a 1-2 sentence summary of what changed across yourself and the spawned souls (this goes to the user's chat). If nothing changed (other than marking entries curated), wrap your final output in <internal>...</internal> so nothing is sent.
`;
}

export function buildEveningJournalPrompt(folder: string): string {
  return `You are performing your evening journal pass.

Do everything in the regular wiki curation pass (see below), then additionally:

A. Daily plan reconciliation
   - Read /workspace/group/soul/daily-plan.json. If the file does not exist, skip steps B and C silently — daily planning is not yet wired up.
   - Compare the planned items against today's entries in memory_stream (timestamp >= start of today, group_folder = '${folder}').
   - Update tasks-and-projects.md with what was actually accomplished today.

B. Archive
   - mkdir -p /workspace/group/soul/plan-history
   - cp /workspace/group/soul/daily-plan.json /workspace/group/soul/plan-history/$(date -u +%Y-%m-%d).json

C. Deep staleness review
   - Walk every wiki page (not just the ones touched by today's entries).
   - Apply the staleness rules from step 7 of the regular curation flow across the whole wiki.

D. Intervention cleanup
   - Query pending interventions:
     sqlite3 /workspace/project/store/messages.db "SELECT id, timestamp, content, metadata FROM memory_stream WHERE group_folder = '${folder}' AND type = 'intervention' AND json_extract(metadata, '\$.status') = 'pending'"
   - For each pending intervention, scan recent observation entries (same group_folder, timestamp >= the intervention's timestamp) to see if the owner already responded with a clear answer.
   - If the owner responded, mark the intervention resolved:
     sqlite3 /workspace/project/store/messages.db "UPDATE memory_stream SET metadata = json_set(metadata, '\$.status', 'resolved', '\$.resolution', 'owner response here') WHERE id = 'intervention-id'"
   - If an intervention is older than 48 hours with no response, mark it expired:
     sqlite3 /workspace/project/store/messages.db "UPDATE memory_stream SET metadata = json_set(metadata, '\$.status', 'expired') WHERE id = 'intervention-id'"
   - SPECIAL CASE — \`spawn_soul\` intervention type: when reconciling, you MUST set both \`status\` AND \`approved\` based on the owner's reply.
     - Affirmative reply (e.g. "yes, spawn it" or any clear approval): set status='resolved' AND approved=1. The host will spawn the soul on the next morning-plan pass.
     - Negative reply: set status='resolved' AND approved=0.
     - Ambiguous: leave pending or mark expired per the rules above.
     Example: sqlite3 /workspace/project/store/messages.db "UPDATE memory_stream SET metadata = json_set(metadata, '\$.status', 'resolved', '\$.approved', 1, '\$.resolution', 'owner approved spawn') WHERE id = 'intervention-id'"

## Regular wiki curation flow

1. Query uncurated memory entries:
   sqlite3 /workspace/project/store/messages.db "SELECT id, timestamp, type, source, content, importance FROM memory_stream WHERE group_folder = '${folder}' AND curated = 0 ORDER BY timestamp ASC LIMIT 200"

2. If there are no uncurated entries, or every returned row has importance <= 2, still do the deep staleness review (step C above), then output a 1-2 sentence end-of-day note (or wrap in <internal> if there's nothing meaningful to report).

3. Read your wiki index at /workspace/group/soul/wiki/_index.md and list the directory.

4. Load relevant wiki pages (same heuristic as in the regular curation prompt).

5. For each entry with importance >= 3, route to the appropriate page (people / preferences / learnings / tasks-and-projects / new topic page).

6. When updating a page: REWRITE sections, do not append. Merge, remove outdated info, refresh <!-- last_confirmed: YYYY-MM-DD --> markers using today's date.

7. Pruning: the wiki should get BETTER, not BIGGER.

8. Mark processed entries as curated:
   sqlite3 /workspace/project/store/messages.db "UPDATE memory_stream SET curated = 1 WHERE id IN ('id1','id2',...)"

9. Send a brief end-of-day summary (1-3 sentences) covering both wiki updates and what got accomplished today. If nothing meaningful happened, wrap in <internal>...</internal>.
`;
}
