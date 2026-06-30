# Blog Draft Delivery — Design

**Status:** approved (design), pending implementation
**Date:** 2026-06-29
**Context:** Winnow conversion funnel (see project Winnow plan §7). The blog-nudge
triage already ships a `📝 Blog:` bet through the Phase 6 bet rails. This spec
covers the *next* funnel stage: when the owner taps "Draft it", deliver writing
material to Telegram so they can write the post elsewhere.

## Problem

Owner is Telegram-only. A blog draft — even the lean "brief + scaffold" form the
inspire-not-write steer calls for — exceeds Telegram's 4096-char text limit, and
the channel has no file-send capability. Two things are missing:

1. A **delivery primitive** — a way to push a file to Telegram.
2. A **trigger + generator** — turning an `acted` blog bet into a `.md` and
   sending it.

Tapping "Draft it" today only resolves the bet (`acted`); nothing generates or
delivers anything.

## Non-goals

- Not writing a finished post. Output is brief + angle options + scaffold — raw
  material for a human writing session (inspire, not author).
- Not auto-verifying facts. The artifact ships with an explicit
  "VERIFY BEFORE PUBLISHING" checklist; verification stays a human/desktop step.
  Auto-running web/CVE verification risks confidently shipping wrong claims.
- Not in-place editing on the phone. Telegram is delivery + triage; real editing
  happens at a desktop with the delivered `.md`.
- No new DB table, no MCP server, no new scheduled task.

## Architecture — two pieces, two PRs

Primitives first, then the feature riding them (same split as PR #12 / #13).

### PR 1 — `sendDocument` primitive (reusable file-send rail)

- **Channel interface:** add optional `sendDocument?(jid, filename, content, caption?)`
  to `src/types.ts`, mirroring the existing optional `editMessage`/`pinMessage`.
  `content` is a string (file body); channel wraps it as a named file.
- **Telegram impl** (`src/channels/telegram.ts`): `bot.api.sendDocument(numericId,
  new InputFile(Buffer.from(content, 'utf8'), filename), { caption })`.
- **WhatsApp:** leave unimplemented (optional method → no break).
- **IPC verb** (`src/ipc.ts`, `processTaskIpc`): `case 'send_document'`. Payload
  `{ type, chatJid, filename, content, caption? }`. Auth = own-chat: a group may
  send to its own chat; main may send anywhere — same posture as `send_message`.
  Route to the owning channel's `sendDocument`; no-op with a logged warning if the
  channel doesn't implement it.
- **MCP tool** (`container/agent-runner/src/ipc-mcp-stdio.ts`): `send_document`
  tool that writes the IPC verb. Params: `chatJid`, `filename`, `content`,
  optional `caption`.
- **Routing helper:** reuse the existing channel-lookup path used by
  `send_message`. No change to `router.ts` signatures required beyond what the
  verb handler needs.

**Tests (PR 1):**
- Telegram `sendDocument` calls `bot.api.sendDocument` with an `InputFile` built
  from the content buffer and the given filename + caption (grammY mocked).
- IPC `send_document` verb: own-chat allowed, cross-group denied for non-main,
  main allowed anywhere; unknown/closed channel handled gracefully.
- MCP `send_document` tool writes a well-formed IPC task file.

### PR 2 — draft assembly + trigger (rides PR 1)

- **Trigger:** extend the existing check-in task (`soul-check-in-main`, every 2h,
  already containerized with DB access). New step: for any `📝 Blog:` bet with
  `status='resolved'` and `resolution='acted'` that has **no draft file yet**,
  assemble the material and deliver it.
- **Idempotency without a table:** write the draft to
  `groups/main/scout/drafts/<bet_id>.md`. File exists ⇒ already delivered ⇒ skip.
- **Assembled `.md` contents:**
  1. Title + the bet's framing.
  2. Facts Scout already has on the topic (knowledge.md deltas + source URLs).
  3. 2–3 angle options (from-the-inside / contrarian / mistake-first).
  4. Voice-shaped scaffold: Dev Notes opener → mistakes-before-solutions arc →
     open-question ending. Each section is a *prompt to the writer*, not prose.
  5. An explicit **VERIFY BEFORE PUBLISHING** checklist (claims to confirm against
     primary sources, e.g. the CVE-conflation class of error).
- **Delivery:** call `send_document` (PR 1) with `filename=<slug>.md`,
  `content=<the assembled markdown>`, `caption="📝 Draft material: <title>"`.

**Tests (PR 2):**
- Check-in prompt includes the draft-delivery step and the file-existence gate
  (prompt-content tests, like the existing bet/check-in tests).
- The host-side check-in gate still fires correctly with the new condition (an
  `acted` blog bet with no draft file is a reason to run).

## Data flow (tap → draft)

1. Owner taps "✅ Act on it" (= Draft it). Host `onChannelEvent` resolves the
   blog bet `acted` (works today).
2. Next check-in (≤2h): container finds the `acted` blog bet with no draft file →
   writes `groups/main/scout/drafts/<bet_id>.md` → calls `send_document` → host
   sends the Telegram attachment → file now exists (idempotent; never re-sends).
3. Owner gets the `.md` in Telegram; takes it to a desktop writing session.

## Accepted trade-offs

- **Latency ≤2h** (check-in interval), not instant. Acceptable for
  non-interactive drafting; immediate-on-event trigger is a later upgrade if it
  ever matters.
- **Unverified brief + checklist**, not verified facts. Intentional — keeps the
  system from confidently publishing wrong claims; verification is human.
- **Silent-loss window** (file-existence idempotency cost): the container writes
  the draft marker file *before* the host async-sends the document. If the
  host-side `sendDocument` then throws (Telegram down, channel error), the marker
  already exists, so the gate won't re-trigger — the draft is lost, not delivered.
  The failure is still observable: the IPC task loop logs the throw and quarantines
  the request to `ipc/errors/`. Accepted for v1 (rare path, no double-send). A
  delivery-status record (instead of file-presence) would enable retry — tracked
  follow-up, not built now. Two related hardening notes also tracked: scope
  `getActedBlogBets` to `group_folder='main'` to match its sole caller, and the
  unbounded 2-hourly retry if a draft write fails persistently.

## Scope guardrails honored (Winnow plan §9)

No new DB table (file-existence state), no MCP server, no new scheduled task
(extends check-in), `sendDocument` is a general primitive useful beyond blogs.
Smaller, not larger.
