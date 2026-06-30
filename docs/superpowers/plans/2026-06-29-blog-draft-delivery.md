# Blog Draft Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the owner taps "Draft it" on a `📝 Blog:` bet, deliver a `.md` (brief + angle options + scaffold + VERIFY checklist) to Telegram as a file attachment.

**Architecture:** Two PRs. PR 1 adds a reusable `sendDocument` primitive across the stack (Channel interface → Telegram impl → IPC verb → MCP tool). PR 2 makes the check-in task assemble the draft `.md` for any `acted` blog bet lacking a draft file and deliver it via that primitive; idempotency is file-existence, no new DB table.

**Tech Stack:** TypeScript, grammY (Telegram), better-sqlite3, vitest, MCP stdio server in the container.

## Global Constraints

- Telegram text/caption hard limit: 4096 chars. Documents have no such body limit; captions still cap at 1024 — keep captions short.
- IPC privileged verbs are dispatched in `processTaskIpc` (`src/ipc.ts`) and authorized via `isMain` / own-chat checks. `send_document` uses own-chat posture (same as `send_message`): a group may send to its own chat, main anywhere.
- Optional `Channel` methods (`editMessage`, `pinMessage`) are the precedent for `sendDocument` — channels that don't implement it are skipped, never crash.
- Blog bets are identified by the title prefix `📝 Blog:` (exact, including the emoji and trailing space-less colon as written by the Scout triage INSERT).
- Draft files live at `groups/<main>/scout/drafts/<bet_id>.md` on the host = `/workspace/group/scout/drafts/<bet_id>.md` in the container.
- Run tests with `npm test`. Build with `npm run build`. Both must pass before each commit.
- Code changes ship via the PR workflow (branch + PR), not direct to `staging`.

---

## PR 1 — `sendDocument` primitive

Branch: `feat/send-document-primitive`

### Task 1: `Channel.sendDocument` interface + Telegram implementation

**Files:**
- Modify: `src/types.ts` (Channel interface, ~line 138-142)
- Modify: `src/channels/telegram.ts` (import line 1; add method after `pinMessage`, ~line 348)
- Test: `src/channels/telegram.test.ts` (mock at ~line 34-38 and 65; new `describe('sendDocument')` block)

**Interfaces:**
- Produces: `Channel.sendDocument?(jid: string, filename: string, content: string, caption?: string): Promise<void>`

- [ ] **Step 1: Add the optional method to the Channel interface**

In `src/types.ts`, inside `interface Channel`, after the `pinMessage` line:

```typescript
  // Optional: send a file (e.g. a markdown draft) as a document attachment.
  // content is the file body; filename is the displayed name.
  sendDocument?(
    jid: string,
    filename: string,
    content: string,
    caption?: string,
  ): Promise<void>;
```

- [ ] **Step 2: Add `InputFile` to the grammY import and `sendDocument` to the test mock**

In `src/channels/telegram.test.ts`, extend the `api` mock (the object near line 34) with:

```typescript
      sendDocument: vi.fn().mockResolvedValue({ message_id: 99 }),
```

And add an `InputFile` export to the `vi.mock('grammy', ...)` factory (alongside `InlineKeyboard`):

```typescript
  InputFile: class MockInputFile {
    constructor(
      public data: Buffer,
      public filename: string,
    ) {}
  },
```

- [ ] **Step 3: Write the failing test**

Add to `src/channels/telegram.test.ts`:

```typescript
  describe('sendDocument', () => {
    it('sends a document via bot API with filename and caption', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendDocument(
        'tg:100200300',
        'draft.md',
        '# Hello\n\nbody',
        '📝 Draft material',
      );

      const call = (currentBot().api.sendDocument as any).mock.calls[0];
      expect(call[0]).toBe('100200300');
      expect(call[1].filename).toBe('draft.md');
      expect(call[1].data.toString('utf8')).toBe('# Hello\n\nbody');
      expect(call[2]).toEqual({ caption: '📝 Draft material' });
    });

    it('omits caption when not provided', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendDocument('tg:100200300', 'd.md', 'x');

      const call = (currentBot().api.sendDocument as any).mock.calls[0];
      expect(call[2]).toEqual({ caption: undefined });
    });
  });
```

- [ ] **Step 4: Run the test, verify it fails**

Run: `npm test -- telegram`
Expected: FAIL — `channel.sendDocument is not a function`.

- [ ] **Step 5: Implement `sendDocument` in the Telegram channel**

In `src/channels/telegram.ts`, change the import line 1 to:

```typescript
import { Bot, InlineKeyboard, InputFile } from 'grammy';
```

Add this method after `pinMessage` (~line 348):

```typescript
  async sendDocument(
    jid: string,
    filename: string,
    content: string,
    caption?: string,
  ): Promise<void> {
    if (!this.bot) throw new Error('Telegram bot not initialized');
    const numericId = jid.replace(/^tg:/, '');
    const file = new InputFile(Buffer.from(content, 'utf8'), filename);
    await this.bot.api.sendDocument(numericId, file, { caption });
    logger.info({ jid, filename, length: content.length }, 'Telegram document sent');
  }
```

- [ ] **Step 6: Run the test, verify it passes**

Run: `npm test -- telegram`
Expected: PASS.

- [ ] **Step 7: Build and commit**

```bash
npm run build
git add src/types.ts src/channels/telegram.ts src/channels/telegram.test.ts
git commit -m "feat(channel): add sendDocument primitive (Telegram)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 2: IPC `send_document` verb

**Files:**
- Modify: `src/ipc.ts` (`IpcDeps` ~line 29-55; new `case 'send_document'` in `processTaskIpc` switch, near the `set_ledger` case ~line 530)
- Test: `src/ipc-auth.test.ts` (mirror the existing `set_ledger` / `publish_bet` auth tests)

**Interfaces:**
- Consumes: `Channel.sendDocument` (Task 1)
- Produces: `IpcDeps.sendDocument?(chatJid: string, filename: string, content: string, caption?: string): Promise<void>`; IPC task `{ type: 'send_document', chatJid, filename, content, caption? }`

- [ ] **Step 1: Add `sendDocument` to `IpcDeps`**

In `src/ipc.ts`, inside `interface IpcDeps`, after the `setLedger?` line:

```typescript
  // Optional: send a file as a document to a chat. Absent in hosts/tests
  // that don't wire channels.
  sendDocument?: (
    chatJid: string,
    filename: string,
    content: string,
    caption?: string,
  ) => Promise<void>;
```

- [ ] **Step 2: Write the failing test**

In `src/ipc-auth.test.ts`, add a test mirroring the `set_ledger` auth tests. Use the file's existing harness for building a deps object and invoking `processTaskIpc` with a `send_document` task from a non-main group targeting another group's chat (expect denied), and from main (expect `sendDocument` called). Follow the exact harness already used for `set_ledger` in that file:

```typescript
  it('send_document: blocks a non-main group targeting another chat', async () => {
    const sendDocument = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ sendDocument });
    await processTaskIpc(
      { type: 'send_document', chatJid: 'tg:999', filename: 'd.md', content: 'x' },
      'someGroup',
      false,
      deps,
    );
    expect(sendDocument).not.toHaveBeenCalled();
  });

  it('send_document: main may send to any chat', async () => {
    const sendDocument = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ sendDocument });
    await processTaskIpc(
      { type: 'send_document', chatJid: 'tg:999', filename: 'd.md', content: 'x', caption: 'c' },
      'main',
      true,
      deps,
    );
    expect(sendDocument).toHaveBeenCalledWith('tg:999', 'd.md', 'x', 'c');
  });
```

(If `makeDeps` / the exact helper name differs in `ipc-auth.test.ts`, match the existing `set_ledger` tests' helpers — read them first and copy the pattern.)

- [ ] **Step 3: Run the test, verify it fails**

Run: `npm test -- ipc-auth`
Expected: FAIL — verb unhandled, `sendDocument` not called for main.

- [ ] **Step 4: Implement the verb**

In `src/ipc.ts`, add before the `default:` case in `processTaskIpc`:

```typescript
    case 'send_document':
      // A group may send a document to its OWN chat; main may send anywhere.
      // Same posture as send_message.
      if (!deps.sendDocument) {
        logger.warn(
          { sourceGroup },
          'send_document requested but host has no channel wired',
        );
        break;
      }
      if (
        !data.chatJid ||
        typeof data.filename !== 'string' ||
        !data.filename ||
        typeof data.content !== 'string' ||
        !data.content
      ) {
        logger.warn({ data }, 'Invalid send_document request');
        break;
      }
      {
        const targetGroup = registeredGroups[data.chatJid];
        if (!isMain && (!targetGroup || targetGroup.folder !== sourceGroup)) {
          logger.warn(
            { chatJid: data.chatJid, sourceGroup },
            'Unauthorized send_document attempt blocked',
          );
          break;
        }
        const caption =
          typeof data.caption === 'string' ? data.caption.slice(0, 1024) : undefined;
        await deps.sendDocument(data.chatJid, data.filename, data.content, caption);
        logger.info(
          { chatJid: data.chatJid, filename: data.filename, sourceGroup },
          'Document sent via IPC',
        );
      }
      break;
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `npm test -- ipc-auth`
Expected: PASS.

- [ ] **Step 6: Build and commit**

```bash
npm run build
git add src/ipc.ts src/ipc-auth.test.ts
git commit -m "feat(ipc): add send_document verb (own-chat auth)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 3: Host wiring + MCP `send_document` tool

**Files:**
- Modify: `src/index.ts` (add `sendDocumentForGroup` near `setLedgerForGroup` ~line 445; pass it in both `IpcDeps` objects ~line 461 and ~line 558)
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts` (new `server.tool('send_document', ...)` after the `set_ledger` tool ~line 100)

**Interfaces:**
- Consumes: `IpcDeps.sendDocument` (Task 2), `Channel.sendDocument` (Task 1)

- [ ] **Step 1: Add `sendDocumentForGroup` in `index.ts`**

After the `setLedgerForGroup` definition (~line 453), add:

```typescript
  const sendDocumentForGroup = (
    chatJid: string,
    filename: string,
    content: string,
    caption?: string,
  ): Promise<void> => {
    const channel = findChannel(channels, chatJid);
    if (!channel) throw new Error(`No channel for JID: ${chatJid}`);
    if (!channel.sendDocument) {
      logger.warn({ chatJid }, 'Channel does not support sendDocument; dropping');
      return Promise.resolve();
    }
    return channel.sendDocument(chatJid, filename, content, caption);
  };
```

- [ ] **Step 2: Wire it into both `IpcDeps` objects**

In `src/index.ts`, both places that build IPC deps (the object passed to `loadCapabilities` ~line 461, and the watcher deps ~line 558) — add the line alongside `setLedger`:

```typescript
    sendDocument: sendDocumentForGroup,
```

- [ ] **Step 3: Build to verify host wiring compiles**

Run: `npm run build`
Expected: clean compile (no test for the thin wiring — it's a pass-through covered by Task 2's verb test and Task 1's channel test).

- [ ] **Step 4: Add the MCP `send_document` tool**

In `container/agent-runner/src/ipc-mcp-stdio.ts`, after the `set_ledger` tool registration (~line 100), add:

```typescript
server.tool(
  'send_document',
  `Send a file to the chat as a document attachment. Use for content too long for a chat message (e.g. a markdown draft or brief). Telegram only.

The file arrives as a downloadable attachment named by \`filename\`. \`caption\` is a short label shown under it (keep well under 1024 chars).`,
  {
    filename: z.string().describe('Displayed file name, e.g. "draft-isolation.md"'),
    content: z.string().describe('The full file body (markdown or text)'),
    caption: z.string().optional().describe('Short label shown under the file'),
  },
  async (args) => {
    const data = {
      type: 'send_document',
      chatJid,
      filename: args.filename,
      content: args.content,
      caption: args.caption,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Document send requested.' }] };
  },
);
```

- [ ] **Step 5: Build the container agent-runner**

Run: `cd container/agent-runner && npx tsc --noEmit && cd ../..`
Expected: clean compile. (If the agent-runner has its own build script, use it; otherwise the entrypoint recompiles the bind-mounted src at container start — see CLAUDE.md.)

- [ ] **Step 6: Commit**

```bash
git add src/index.ts container/agent-runner/src/ipc-mcp-stdio.ts
git commit -m "feat: wire send_document host helper + MCP tool

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 7: Open PR 1**

```bash
git push -u origin feat/send-document-primitive
gh pr create --base staging --title "feat: sendDocument primitive (channel + IPC + MCP)" --body "$(cat <<'EOF'
Adds a reusable file-send rail: Channel.sendDocument (Telegram via grammY InputFile), the send_document IPC verb (own-chat auth, same posture as send_message), host wiring, and the send_document MCP tool.

Foundation for blog-draft delivery (PR 2). No behavior change on its own.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## PR 2 — Draft assembly + check-in trigger

Branch: `feat/blog-draft-delivery` (off `staging` after PR 1 merges, or stacked on PR 1).

### Task 4: `getActedBlogBets` helper + blog prefix constant

**Files:**
- Modify: `src/capabilities/soul/bet-store.ts` (add constant near `MAX_OPEN_BETS` ~line 12; add function after `getRecentResolvedBets` ~line 112)
- Test: `src/capabilities/soul/soul.test.ts` (add a test alongside existing bet-store tests)

**Interfaces:**
- Produces: `BLOG_BET_PREFIX: string`; `getActedBlogBets(db: Database.Database): Bet[]`

- [ ] **Step 1: Write the failing test**

In `src/capabilities/soul/soul.test.ts`, in the bet-store test area, add (adapt DB setup to the file's existing in-memory bet test helper):

```typescript
  it('getActedBlogBets returns only resolved+acted blog bets', () => {
    const db = makeBetTestDb(); // existing helper that creates the bets table
    const ins = (id: string, title: string, status: string, resolution: string | null) =>
      db.prepare(
        `INSERT INTO bets (id, group_folder, title, body, status, created_at, window_days, resolution)
         VALUES (?, 'main', ?, 'b', ?, datetime('now'), 7, ?)`,
      ).run(id, title, status, resolution);
    ins('a', '📝 Blog: topic one', 'resolved', 'acted');
    ins('b', '📝 Blog: topic two', 'resolved', 'rejected');
    ins('c', '🎯 normal bet', 'resolved', 'acted');
    ins('d', '📝 Blog: topic three', 'sent', null);

    const result = getActedBlogBets(db).map((x) => x.id);
    expect(result).toEqual(['a']);
  });
```

(If `makeBetTestDb` doesn't exist, create the table inline with the same schema as `migrations.ts`'s bets table — copy it verbatim.)

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm test -- soul`
Expected: FAIL — `getActedBlogBets` not exported.

- [ ] **Step 3: Implement the constant and helper**

In `src/capabilities/soul/bet-store.ts`, after `MAX_OPEN_BETS` (~line 12):

```typescript
// Blog candidates are bets whose title carries this exact prefix (written by
// the Scout blog-triage INSERT). Used to route them to draft delivery.
export const BLOG_BET_PREFIX = '📝 Blog:';
```

After `getRecentResolvedBets` (~line 112):

```typescript
// Blog bets the owner chose to draft (resolved as 'acted'). The host pairs
// these with on-disk draft files to decide which still need generating.
export function getActedBlogBets(db: Database.Database): Bet[] {
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM bets
        WHERE status = 'resolved' AND resolution = 'acted'
          AND title LIKE ? || '%'
        ORDER BY resolved_at DESC`,
    )
    .all(BLOG_BET_PREFIX) as BetRow[];
  return rows.map(rowToBet);
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npm test -- soul`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run build
git add src/capabilities/soul/bet-store.ts src/capabilities/soul/soul.test.ts
git commit -m "feat(soul): getActedBlogBets helper + blog prefix constant

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 5: Check-in gate fires for pending blog drafts

**Files:**
- Modify: `src/capabilities/soul/index.ts` (imports ~line 37-45 add `getActedBlogBets`; check-in gate ~line 870-937)
- Test: `src/capabilities/soul/soul.test.ts` (gate test alongside existing check-in gate tests)

**Interfaces:**
- Consumes: `getActedBlogBets` (Task 4)

- [ ] **Step 1: Write the failing test**

Add to `src/capabilities/soul/soul.test.ts` in the check-in gate test area. Use the existing gate-test harness (it builds the capability with a temp `groupsDir` and `db`). The new expectation: an `acted` blog bet whose draft file does NOT exist makes the gate return `true` even when budget is exhausted and there are no proposed/sent bets:

```typescript
  it('check-in gate runs when an acted blog bet has no draft file', () => {
    const { gate, db, groupsDir } = makeCheckInGateHarness(); // existing/derived harness
    db.prepare(
      `INSERT INTO bets (id, group_folder, title, body, status, created_at, window_days, resolution, resolved_at)
       VALUES ('blog1', 'main', '📝 Blog: x', 'b', 'resolved', datetime('now'), 7, 'acted', datetime('now'))`,
    ).run();
    // no file at groups/main/scout/drafts/blog1.md
    expect(gate({ id: 'soul-check-in-main' } as any)).toBe(true);
  });

  it('check-in gate does NOT run for an acted blog bet already drafted', () => {
    const { gate, db, groupsDir } = makeCheckInGateHarness();
    db.prepare(
      `INSERT INTO bets (id, group_folder, title, body, status, created_at, window_days, resolution, resolved_at)
       VALUES ('blog2', 'main', '📝 Blog: y', 'b', 'resolved', datetime('now'), 7, 'acted', datetime('now'))`,
    ).run();
    const dir = path.join(groupsDir, 'main', 'scout', 'drafts');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'blog2.md'), 'done');
    // budget exhausted + no other work → false
    expect(gate({ id: 'soul-check-in-main' } as any)).toBe(false);
  });
```

(If no `makeCheckInGateHarness` exists, model it on however the file currently tests the `beforeTaskRun` gate — reuse that setup verbatim and just add the two bet rows / file.)

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm test -- soul`
Expected: FAIL — gate returns false for the un-drafted blog bet.

- [ ] **Step 3: Add the import**

In `src/capabilities/soul/index.ts`, add `getActedBlogBets` to the import block from `./bet-store.js` (~line 37-45).

- [ ] **Step 4: Add the pending-draft condition to the gate**

In the check-in gate (`if (task.id === \`soul-check-in-${MAIN_GROUP_FOLDER}\`)`), after the `planHasReminder` block and before the final `return`, insert:

```typescript
        let hasPendingDraft = false;
        try {
          const draftsDir = path.join(
            groupsDir,
            MAIN_GROUP_FOLDER,
            'scout',
            'drafts',
          );
          for (const bet of getActedBlogBets(db)) {
            if (!fs.existsSync(path.join(draftsDir, `${bet.id}.md`))) {
              hasPendingDraft = true;
              break;
            }
          }
        } catch (err) {
          logger.error({ err }, 'Failed to check pending blog drafts');
        }
```

Then change the final `return` of the check-in branch to:

```typescript
        return (
          (hasProposed && budgetOk) ||
          ownerSpokeRecently ||
          (planHasReminder && budgetOk) ||
          hasPendingDraft
        );
```

(Draft delivery is NOT budget-gated — it's a direct response to the owner tapping "Draft it", not unsolicited outreach.)

- [ ] **Step 5: Run the test, verify it passes**

Run: `npm test -- soul`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npm run build
git add src/capabilities/soul/index.ts src/capabilities/soul/soul.test.ts
git commit -m "feat(soul): check-in gate fires for pending blog drafts

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 6: Check-in prompt assembles and delivers the draft

**Files:**
- Modify: `src/capabilities/soul/planning-prompts.ts` (the check-in prompt function ~line 92)
- Test: `src/capabilities/soul/soul.test.ts` (prompt-content test alongside existing check-in prompt tests)

**Interfaces:**
- Consumes: the `send_document` MCP tool (Task 3), `getActedBlogBets` semantics (Task 4)

- [ ] **Step 1: Write the failing prompt-content test**

In `src/capabilities/soul/soul.test.ts`, alongside existing check-in prompt tests:

```typescript
  it('check-in prompt instructs blog-draft assembly + send_document', () => {
    const prompt = buildCheckInPrompt('main'); // match the file's actual prompt builder name/args
    expect(prompt).toContain('scout/drafts/');
    expect(prompt).toContain('send_document');
    expect(prompt).toContain('VERIFY BEFORE PUBLISHING');
  });
```

(Use the real exported prompt builder for the check-in task — find it in `planning-prompts.ts` and import it as the existing prompt tests do.)

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm test -- soul`
Expected: FAIL — strings not present.

- [ ] **Step 3: Add the draft-delivery step to the check-in prompt**

In `src/capabilities/soul/planning-prompts.ts`, append this section to the check-in prompt body (after the existing reminder step, before the closing guidance):

```
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
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npm test -- soul`
Expected: PASS.

- [ ] **Step 5: Full test run + build**

Run: `npm test && npm run build`
Expected: all pass, clean build.

- [ ] **Step 6: Commit**

```bash
git add src/capabilities/soul/planning-prompts.ts src/capabilities/soul/soul.test.ts
git commit -m "feat(soul): check-in assembles + delivers blog drafts via send_document

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 7: Open PR 2**

```bash
git push -u origin feat/blog-draft-delivery
gh pr create --base staging --title "feat: blog draft delivery (check-in → send_document)" --body "$(cat <<'EOF'
When the owner taps "Draft it" on a 📝 Blog: bet, the next check-in assembles a brief + angle options + voice scaffold + VERIFY checklist and delivers it as a .md document (PR 1's send_document). Idempotency is file-existence (groups/main/scout/drafts/<bet_id>.md) — no new DB table. Draft delivery is not budget-gated (it answers an explicit owner tap).

Inspire-not-write: the artifact is writing material, explicitly unverified, not a finished post.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- sendDocument primitive (Channel/Telegram/IPC/MCP) → Tasks 1-3. ✓
- Check-in trigger for acted blog bets → Tasks 4-5. ✓
- Draft `.md` assembly (facts + angles + scaffold + VERIFY checklist) → Task 6. ✓
- Idempotency via file-existence → Task 5 (gate) + Task 6 (prompt). ✓
- No new DB table / no MCP server / no new scheduled task → honored (extends check-in, file state). ✓
- Latency ≤2h (check-in interval) → inherent to Task 5 trigger. ✓
- Unverified-brief-with-checklist → Task 6 prompt. ✓

**Placeholder scan:** No TBD/TODO. Test-harness helper names (`makeDeps`, `makeBetTestDb`, `makeCheckInGateHarness`, `buildCheckInPrompt`) are flagged where the executor must match the file's actual existing helpers — each notes "copy the existing pattern" because the precise names live in the test files and must not be invented.

**Type consistency:** `sendDocument(jid/chatJid, filename, content, caption?)` is identical across Channel, IpcDeps, host helper, IPC verb payload, and MCP tool. `getActedBlogBets(db): Bet[]` and `BLOG_BET_PREFIX` match between bet-store, the gate, and tests. Draft path `groups/main/scout/drafts/<bet_id>.md` (host) = `/workspace/group/scout/drafts/<bet_id>.md` (container) is consistent in gate, prompt, and idempotency check.
