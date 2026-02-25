# Intent: src/index.ts modifications

## What changed
Refactored from single WhatsApp channel to multi-channel architecture using the `Channel` interface. This enables voice (and future channels) to work alongside WhatsApp seamlessly.

## Key sections

### Imports (top of file, lines 1-45)
- Added: `VoiceChannel` from `./channels/voice.js`
- Added: Voice config exports from `./config.js` (`VOICE_ENABLED`, `VOICE_PORT`, `VOICE_HOST`, `VOICE_GROUP`)
- Added: `findChannel` import from `./router.js`
- Added: `Channel` type from `./types.js`

### Module-level state (lines 50-58)
- Added: `const channels: Channel[] = []` — array of all active channels
- Added: `const queue = new GroupQueue()` — already existed, used for multi-channel
- Kept: `let whatsapp: WhatsAppChannel` — still needed for specific references like `syncGroupMetadata`

### processGroupMessages() (lines 128-217)
- Added: `const channel = findChannel(channels, chatJid)` lookup at start
- Changed: `whatsapp.setTyping()` → `channel.setTyping?.()` (optional chaining, line 175)
- Changed: `await whatsapp.sendMessage()` → `await channel.sendMessage()` (line 187)
- All error handling and cursor management unchanged

### startMessageLoop() (lines 298-382)
- Added: `const channel = findChannel(channels, chatJid)` lookup per group (line 334)
- Changed: `whatsapp.setTyping()` → `channel.setTyping?.()` for typing indicators (line 370)
- Message deduplication and trigger detection logic unchanged

### main() — channel initialization (lines 464-514)
- Changed: WhatsApp connection now pushes to `channels` array (lines 489-491)
- Added: Conditional VoiceChannel creation if `VOICE_ENABLED` (lines 493-514)
  - Creates VoiceChannel with same channel options
  - Pushes to `channels` array
  - Registers the voice group automatically
  - Uses `VOICE_GROUP` to determine which group receives voice messages

### main() — subsystem setup (lines 517-540)
- Changed: `sendMessage: (jid, text) => whatsapp.sendMessage()` → via `findChannel()` (lines 522-527)
- Changed: IPC `sendMessage` uses `findChannel()` instead of hardcoded `whatsapp` (lines 530-534)
- Changed: Shutdown handler disconnects all channels via loop (line 474): `for (const ch of channels) await ch.disconnect()`

## Invariants

- All existing message processing logic (triggers, cursors, idle timers) is **preserved exactly**
- The `runAgent` function is **completely unchanged** — still handles container execution, session management, task snapshots
- State management (`loadState`/`saveState`) is **unchanged**
- Recovery logic for pending messages is **unchanged**
- Container runtime check (`ensureContainerSystemRunning`) is **unchanged**
- All error handling and cursor rollback logic in `processGroupMessages` is **preserved**

## Why these changes are safe

1. **findChannel is a router utility** — it uses `ownsJid()` to dispatch to the correct channel. WhatsApp JIDs remain unchanged (`123@g.us`, `123@s.whatsapp.net`), voice JIDs have new format (`voice:main@local`). No ambiguity.

2. **Optional chaining (?.)** on `setTyping` — WhatsAppChannel always has `setTyping`, voice does too. Optional chaining is defensive for future channels that might not implement this method.

3. **No logic changes** — channels array is just an indirection. All the core logic (message deduplication, trigger detection, idle timeouts, error recovery) stays the same. Only the *destination* changes.

4. **Voice JID format is isolated** — `voice:main@local` will only match VoiceChannel's `ownsJid()` check. Won't collide with WhatsApp or other channels.

5. **Group registration is backward-compatible** — voice group is only registered if `VOICE_ENABLED=true` and it's not already registered. Won't interfere with existing groups.

## Must-keep code blocks

- Lines 47-48: Re-exports for backwards compatibility
- Lines 60-83: `loadState()` and `saveState()` — unchanged
- Lines 85-97: `registerGroup()` — unchanged
- Lines 99-117: `getAvailableGroups()` — unchanged
- Lines 119-122: `_setRegisteredGroups()` test helper — unchanged
- Lines 219-296: `runAgent()` — completely unchanged
- Lines 388-400: `recoverPendingMessages()` — unchanged
- Lines 402-462: `ensureContainerSystemRunning()` — unchanged
- Lines 546-556: Direct run guard at bottom — unchanged

These blocks form the core logic and must not be modified by other skills or future refactors.
