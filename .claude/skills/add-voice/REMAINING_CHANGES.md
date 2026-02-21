# Remaining Changes for add-voice Skill

Most changes have been completed automatically. These remaining sections in SKILL.md need manual updates:

## 1. Update Step 3: Orchestrator Integration (formerly Step 5)

**Location:** Around line 403 in SKILL.md

### Find this section:
```markdown
### Step 5: Update Orchestrator
...
1. **Add imports**:
```typescript
import { VoiceChannel } from './channels/voice.js';
import { VOICE_ENABLED, VOICE_PORT, VOICE_HOST, VOICE_GROUP,
         VOICE_STT_URL, VOICE_TTS_URL } from './config.js';
```
```

### Replace with:
```markdown
### Step 3: Multi-Channel Refactoring

The current `index.ts` directly references `whatsapp` throughout. We need to refactor to support multiple channels.

#### 3a. Add channel utilities

At the top of `index.ts`, after the `whatsapp` declaration:

```typescript
const channels: Channel[] = [];

function findChannel(jid: string): Channel | undefined {
  return channels.find(c => c.ownsJid(jid));
}
```

#### 3b. Update processGroupMessages

Replace direct `whatsapp` calls with channel lookups:

```typescript
// Line ~164: Replace
await whatsapp.setTyping(chatJid, true);
// With
const channel = findChannel(chatJid);
await channel?.setTyping?.(chatJid, true);

// Line ~176: Replace  
await whatsapp.sendMessage(chatJid, text);
// With
await channel?.sendMessage(chatJid, text);

// Line ~188: Replace
await whatsapp.setTyping(chatJid, false);
// With
await channel?.setTyping?.(chatJid, false);
```

#### 3c. Update startMessageLoop

```typescript
// Line ~356: Replace
whatsapp.setTyping(chatJid, true);
// With
const channel = findChannel(chatJid);
await channel?.setTyping?.(chatJid, true);
```

#### 3d. Update main() channel initialization

Replace:
```typescript
whatsapp = new WhatsAppChannel({...});
await whatsapp.connect();
```

With:
```typescript
whatsapp = new WhatsAppChannel({...});
channels.push(whatsapp);
await whatsapp.connect();
```

#### 3e. Update shutdown handler

In `main()`, replace:
```typescript
await whatsapp.disconnect();
```

With:
```typescript
for (const channel of channels) {
  await channel.disconnect();
}
```

#### 3f. Update IPC and scheduler

In `startIpcWatcher` and `startSchedulerLoop`, replace:
```typescript
sendMessage: (jid, text) => whatsapp.sendMessage(jid, text),
```

With:
```typescript
sendMessage: async (jid, text) => {
  const channel = findChannel(jid);
  if (channel) await channel.sendMessage(jid, text);
},
```

### Step 4: Add Voice Channel to Orchestrator

**Add imports:**
```typescript
import { VoiceChannel } from './channels/voice.js';
import { VOICE_ENABLED, VOICE_PORT, VOICE_HOST, VOICE_GROUP } from './config.js';
```

**In `main()`, after WhatsApp channel is created:**
```typescript
if (VOICE_ENABLED) {
  const voiceJid = `voice:${VOICE_GROUP}@local`;
  const voice = new VoiceChannel({
    ...channelOpts,
    port: VOICE_PORT,
    host: VOICE_HOST,
    groupJid: voiceJid,
  });
  channels.push(voice);
  await voice.connect();

  // Register the voice group
  if (!registeredGroups[voiceJid]) {
    registerGroup(voiceJid, {
      name: `Voice (${VOICE_GROUP})`,
      folder: VOICE_GROUP,
      trigger: `@${ASSISTANT_NAME}`,
      added_at: new Date().toISOString(),
      requiresTrigger: false, // all speech is intentional
    });
  }
}
```

**Update `getAvailableGroups` filter:**
```typescript
.filter((c) => c.jid !== '__group_sync__' &&
  (c.jid.endsWith('@g.us') || c.jid.startsWith('voice:')))
```

*Note: Removed forward reference to `tg:` prefix since Telegram isn't implemented yet.*
```

---

## 2. Update Environment Variables Section (Step 7 → Step 5)

**Find:**
```markdown
### Step 7: Environment

Add to `.env`:

```bash
# Voice channel
VOICE_ENABLED=true
VOICE_AUTH_TOKEN=<generate a random token>
VOICE_PORT=8443
VOICE_GROUP=main
# VOICE_STT_URL=http://127.0.0.1:8700  (default)
# VOICE_TTS_URL=http://127.0.0.1:8701  (default)
```
```

**Replace with:**
```markdown
### Step 5: Environment Variables

Add to `.env`:

```bash
# Voice channel
VOICE_ENABLED=true
VOICE_AUTH_TOKEN=$(openssl rand -hex 32)
VOICE_PORT=8443
VOICE_HOST=127.0.0.1  # Keep as localhost for Tailscale
VOICE_GROUP=main

# Smallest.ai API
SMALLEST_AI_API_KEY=<your key from https://www.smallest.ai/>
```

Sync to container env: `cp .env data/env/env`

**For remote access via Tailscale:**
- Keep `VOICE_HOST=127.0.0.1` (localhost)
- Access from remote machine using Tailscale IP (e.g., `http://100.64.1.5:8443`)
- Tailscale proxies the connection securely through encrypted tunnel
```

---

## 3. Update Build and Test Section (Step 8 → Step 6)

**Find:**
```markdown
### Step 8: Build and Test

```bash
# Terminal 1: Start STT service
cd services/stt && ../. .venv/bin/activate && python server.py

# Terminal 2: Start TTS service
cd services/tts && source ../.venv/bin/activate && python server.py

# Terminal 3: Build and run NanoClaw
npm run build
VOICE_ENABLED=true npm run dev

# Open browser
open http://localhost:8443
```
```

**Replace with:**
```markdown
### Step 6: Build and Test

```bash
# Build and run NanoClaw
npm run build
VOICE_ENABLED=true npm run dev

# Open browser
open http://localhost:8443
```

**For testing on remote Linux machine via Tailscale:**
1. On Linux machine, get Tailscale IP: `tailscale ip -4` (e.g., `100.64.1.5`)
2. On your Mac: `open http://100.64.1.5:8443`
3. Enter auth token from `.env` and click Connect
4. When you see "listening", start speaking

**First request latency:** 1-2 seconds (Smallest.ai API cold start)  
**Subsequent requests:** <100ms
```

---

## 4. Add Smoke Tests Section (Before Troubleshooting)

**Insert this new section before "## Troubleshooting":**

```markdown
## Smoke Tests

Verify each component before testing the full pipeline:

### 1. Verify API Key
```bash
curl https://api.smallest.ai/api/Transcribe \
  -H "Authorization: Bearer $SMALLEST_AI_API_KEY" \
  -X POST

# 400 = key valid, 401 = invalid
```

### 2. Test STT
```bash
rec -t wav -r 16000 -c 1 test.wav trim 0 3

curl https://api.smallest.ai/api/Transcribe \
  -H "Authorization: Bearer $SMALLEST_AI_API_KEY" \
  -F "audio=@test.wav" \
  -F "language=en"

# Expected: {"text": "..."}
```

### 3. Test TTS
```bash
curl https://api.smallest.ai/api/Speak \
  -H "Authorization: Bearer $SMALLEST_AI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello", "sample_rate": 24000, "format": "pcm"}' \
  -o test.pcm

ffmpeg -f s16le -ar 24000 -ac 1 -i test.pcm test.wav
afplay test.wav
```

### 4. WebSocket Connection
Open browser console at voice channel URL, verify:
- WebSocket connects to `ws://<host>:8443/voice`
- Auth message sent, receives `auth_ok`
- Status changes to "listening"

### 5. Full Voice Pipeline
Speak into microphone, verify:
- Transcript appears in UI
- Agent response text appears  
- Audio plays back

Only after all five pass is the voice channel working correctly.
```

---

## 5. Update Troubleshooting Section

**Find the "## Troubleshooting" section and replace entire content with:**

```markdown
## Troubleshooting

### Smallest.ai API not responding
```bash
# Check API key is set
echo $SMALLEST_AI_API_KEY

# Test authentication
curl https://api.smallest.ai/api/Transcribe \
  -H "Authorization: Bearer $SMALLEST_AI_API_KEY" \
  -X POST

# 400 = valid, 401 = invalid, 500+ = API issue
```

### High latency (>2 seconds)
- First request is slower (API cold start)
- Check network: `ping api.smallest.ai`
- Verify not rate-limited (check Smallest.ai dashboard)

### No audio in browser
- Check browser microphone permissions
- Verify WebSocket connects (dev tools → Network → WS)
- Ensure `VOICE_AUTH_TOKEN` matches `.env` and web client

### Voice channel not starting
- Verify `VOICE_ENABLED=true` in `.env`
- Check port: `lsof -i :8443`
- Check logs: `tail -f logs/nanoclaw.log | grep -i voice`
- Verify `SMALLEST_AI_API_KEY` is set

### "Smallest.ai returned 401"
- API key invalid or expired
- Check key at https://www.smallest.ai/
- Ensure synced to `data/env/env`

### "Smallest.ai returned 429"
- Rate limit exceeded
- Check plan limits at dashboard
- Consider upgrading or request queuing

### Cannot connect from remote machine
- Verify Tailscale is running on both machines: `tailscale status`
- Check you can ping the host: `ping <tailscale-ip>`
- Confirm NanoClaw is listening: `lsof -i :8443` on host
- Ensure `VOICE_HOST=127.0.0.1` (Tailscale proxies localhost)
```

---

## 6. Add New Documentation Sections (Before Troubleshooting)

**Insert these sections after the "Web Client" step:**

```markdown
## Multi-Client Behavior

**Current implementation broadcasts to all connected clients:**
- Multiple browsers receive all transcripts and TTS audio
- All clients share same conversation context (mapped to `VOICE_GROUP`)
- Appropriate for single-user, multi-device (phone + laptop)

**Not supported:**
- Multi-user voice with separate contexts
- Per-client authentication/authorization
- Individual conversation histories

For true multi-user, each client needs unique `voice:${sessionId}@local` JID.

## Rate Limiting & Cost Management

Smallest.ai has rate limits and per-request costs.

### Recommended Safeguards
1. **Client-side VAD tuning**: `MIN_SPEECH_FRAMES` prevents sub-0.5s fragments
2. **Request queuing**: Queue requests to stay within rate limits
3. **Fallback to text**: On 429 errors, disable TTS temporarily
4. **Monitor usage**: Log API calls, track costs via dashboard

### Cost Estimation
Typical conversation:
- STT: ~10 requests/minute (user speaking)
- TTS: ~10 requests/minute (agent responding)

Check pricing: https://www.smallest.ai/pricing

## Voice Customization

Smallest.ai supports multiple TTS voices. In `synthesizeWithSmallest`:

```typescript
body: JSON.stringify({
  text,
  voice_id: 'emma',  // Options: 'default', 'emma', 'ryan'
  sample_rate: 24000,
  format: 'pcm',
  speaking_rate: 1.0,  // 0.5 to 2.0
  pitch: 0,            // -20 to 20 semitones
}),
```

See: https://www.smallest.ai/docs/tts

## Post-Implementation

After successfully implementing:

1. **Update AGENTS.md** to document:
   - Voice channel availability
   - Configuration (auth token, ports)
   - Access methods (localhost vs Tailscale)
   - Group mapping
   - Smallest.ai API requirements

2. **Add tests** (optional but recommended per project rules)
```

---

## Summary

These remaining changes cover:
- **Multi-channel refactoring** (critical for voice to work)
- **Environment variables** with Tailscale guidance
- **Simplified testing** without Python services
- **Smoke tests** for Smallest.ai API validation
- **Updated troubleshooting** for API-specific issues
- **New documentation** on multi-client behavior, rate limiting, customization

All code changes have been completed. These are documentation updates needed for the skill to guide users correctly.
