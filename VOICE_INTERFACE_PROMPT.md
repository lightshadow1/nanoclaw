# Voice Interface for NanoClaw — Coding Prompt

> **Scope**: Design and implementation specification only. No code in this document.
> **Target**: A coding agent (Claude Code, Cursor, etc.) implementing this feature against the NanoClaw codebase.
> **Constraint**: This adds a new channel. It must not break existing WhatsApp functionality.

---

## 1. What You're Building

A real-time voice channel for NanoClaw that lets the user speak to their agent from anywhere over a secure connection. Audio streams bidirectionally over WebSocket — the user's voice is transcribed server-side via faster-whisper, routed through NanoClaw's existing orchestrator to a container agent, and the agent's text response is synthesized back to speech via Piper or Kokoro TTS and streamed to the client.

The voice channel is a peer to the WhatsApp channel, not a replacement. Both can run simultaneously. A voice session can map to the same group context as a WhatsApp group (shared CLAUDE.md, shared session), or it can have its own dedicated group.

---

## 2. Architecture Overview

```
┌──────────────┐     Tailscale/WireGuard      ┌────────────────────────────────┐
│  Client       │◄──────── WSS ──────────────►│  NanoClaw Host (Mac)            │
│  (Phone/Web)  │     encrypted tunnel         │                                │
│               │                              │  ┌──────────────────────────┐  │
│  mic → VAD ───┼── audio chunks (opus/pcm) ──►│  │  VoiceChannel            │  │
│               │                              │  │  (WebSocket server)       │  │
│  speaker ◄────┼── audio chunks (opus/pcm) ◄──│  │                          │  │
│               │                              │  │  audio in → faster-whisper│  │
│               │                              │  │  text out → Piper/Kokoro  │  │
│               │                              │  └──────────┬───────────────┘  │
│               │                              │             │                  │
│               │                              │             │ implements       │
│               │                              │             │ Channel iface    │
│               │                              │             ▼                  │
│               │                              │  ┌──────────────────────────┐  │
│               │                              │  │  Orchestrator (index.ts)  │  │
│               │                              │  │  - GroupQueue             │  │
│               │                              │  │  - Container Runner       │  │
│               │                              │  │  - IPC Watcher            │  │
│               │                              │  └──────────────────────────┘  │
└──────────────┘                              └────────────────────────────────┘
```

---

## 3. Existing Codebase Interfaces You Must Conform To

### 3.1 Channel Interface (`src/types.ts`)

```typescript
interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
}

type OnInboundMessage = (chatJid: string, message: NewMessage) => void;
type OnChatMetadata = (chatJid: string, timestamp: string, name?: string) => void;
```

Your `VoiceChannel` must implement `Channel`. The orchestrator in `src/index.ts` currently hardcodes `whatsapp` — you will need to generalize it to support multiple channels.

### 3.2 Orchestrator Integration Points (`src/index.ts`)

The orchestrator currently does:

1. Creates WhatsApp channel with `onMessage` and `onChatMetadata` callbacks (line 467-471)
2. Calls `whatsapp.connect()` (line 474)
3. Passes `whatsapp.sendMessage` to subsystems: scheduler (line 482-484), IPC watcher (line 488)
4. Calls `whatsapp.setTyping` in `processGroupMessages` (line 164, 188)
5. The message loop polls SQLite for new messages from registered groups (line 296-367)
6. `queue.sendMessage` pipes follow-up messages to active containers via IPC (line 347)
7. Graceful shutdown calls `whatsapp.disconnect()` (line 461)

You need to modify `index.ts` to:
- Maintain an array of `Channel[]` instead of a single `whatsapp` variable
- Route outbound messages through `routeOutbound` (already exists in `src/router.ts` line 29-37)
- Register the VoiceChannel alongside WhatsApp in `main()`

### 3.3 Router (`src/router.ts`)

Already has the multi-channel routing logic:

```typescript
function routeOutbound(channels: Channel[], jid: string, text: string): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}
```

Your VoiceChannel's `ownsJid` must return `true` for voice JIDs (e.g., `voice:default@local`).

### 3.4 Group Registration

Groups are registered in SQLite via `src/db.ts`:

```typescript
interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean;
}
```

Voice groups should be registered with `requiresTrigger: false` (all speech is intentional — no need for `@Andy` prefix). The `trigger` field should still be set for consistency (e.g., `^@Andy\b` pattern) but won't be checked.

### 3.5 Config (`src/config.ts`)

Add voice-specific config constants following the existing pattern:

- `VOICE_PORT` — WebSocket server port (default: `8443`)
- `VOICE_HOST` — Bind address (default: `127.0.0.1` — Tailscale handles external access)
- `VOICE_TLS_CERT` / `VOICE_TLS_KEY` — Optional TLS for defense-in-depth over Tailscale
- `VOICE_STT_MODEL` — faster-whisper model name (default: `small`)
- `VOICE_TTS_ENGINE` — `piper` or `kokoro` (default: `piper`)
- `VOICE_GROUP` — Which group folder the voice channel maps to (default: `main`)
- `VOICE_ENABLED` — Feature flag (default: `false`)

Read from `.env` via the existing `readEnvFile` pattern.

---

## 4. VoiceChannel Implementation Specification

### 4.1 File Location

Create `src/channels/voice.ts` following the pattern of `src/channels/whatsapp.ts`.

### 4.2 Constructor

```typescript
interface VoiceChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  port: number;
  host: string;
  tlsCert?: string;
  tlsKey?: string;
  sttModel: string;
  ttsEngine: 'piper' | 'kokoro';
  groupJid: string;  // The JID this voice channel is bound to
}
```

### 4.3 JID Scheme

Voice channels use synthetic JIDs: `voice:{name}@local`

- `voice:default@local` — Primary voice endpoint (maps to a configured group)
- `voice:main@local` — Could map directly to the main group

The `ownsJid` method returns `true` for any JID matching `voice:*@local`.

### 4.4 WebSocket Protocol

#### Connection Handshake

Client connects to `wss://{host}:{port}/voice`. The server accepts the WebSocket upgrade.

Authentication: The first message from the client must be a JSON auth frame:

```json
{
  "type": "auth",
  "token": "<pre-shared secret from .env>"
}
```

The server validates the token against `VOICE_AUTH_TOKEN` from `.env`. On failure, close the WebSocket with code 4001. On success, respond:

```json
{
  "type": "auth_ok",
  "sessionId": "<uuid>"
}
```

#### Audio Frames (Client → Server)

```json
{
  "type": "audio",
  "data": "<base64-encoded audio chunk>",
  "format": "pcm_s16le",
  "sampleRate": 16000,
  "channels": 1,
  "isFinal": false
}
```

- `isFinal: true` signals end of utterance (VAD detected silence)
- Audio format: 16-bit PCM, 16kHz, mono (optimal for Whisper)
- Chunk size: ~100ms of audio per frame (1600 samples = 3200 bytes)

Alternative: use Opus codec for bandwidth efficiency over cellular. Server decodes to PCM before STT.

#### Transcription Events (Server → Client)

```json
{
  "type": "transcript",
  "text": "what's the weather like today",
  "isFinal": true,
  "confidence": 0.94
}
```

Partial transcripts (`isFinal: false`) provide real-time feedback. Final transcript triggers agent invocation.

#### Agent Response Audio (Server → Client)

```json
{
  "type": "audio_response",
  "data": "<base64-encoded audio chunk>",
  "format": "pcm_s16le",
  "sampleRate": 22050,
  "text": "It's currently 72°F and sunny.",
  "isFinal": false
}
```

- Stream audio chunks as TTS generates them (sentence-by-sentence)
- Include `text` for client-side display
- `isFinal: true` on the last chunk

#### Status Events (Server → Client)

```json
{"type": "status", "state": "listening"}
{"type": "status", "state": "transcribing"}
{"type": "status", "state": "thinking"}
{"type": "status", "state": "speaking"}
{"type": "status", "state": "error", "message": "STT failed"}
```

### 4.5 STT Integration (faster-whisper)

**Option A: Subprocess**
Run `faster-whisper` as a Python subprocess. Write audio to a temp file, invoke `faster-whisper` CLI, read transcription from stdout. Simple but adds ~200ms per-invocation overhead.

**Option B: Persistent Python service**
A small Python FastAPI/Flask service running alongside NanoClaw that:
- Accepts audio via HTTP POST or WebSocket
- Runs faster-whisper in-process (model stays loaded in memory)
- Returns transcription as JSON

Recommended: Option B for latency. The STT service starts alongside NanoClaw (managed by launchd or spawned in `main()`).

**STT Service Specification:**

```
POST /transcribe
Content-Type: application/octet-stream
X-Sample-Rate: 16000
X-Format: pcm_s16le

Body: raw audio bytes

Response:
{
  "text": "transcribed text",
  "language": "en",
  "confidence": 0.94,
  "duration_ms": 487
}
```

Place the STT service code at `services/stt/` with its own `requirements.txt` (faster-whisper, flask/fastapi, uvicorn).

### 4.6 TTS Integration (Piper or Kokoro)

Same pattern as STT — a persistent service that accepts text and returns audio.

**TTS Service Specification:**

```
POST /synthesize
Content-Type: application/json

{
  "text": "It's currently 72 degrees and sunny.",
  "voice": "en_US-amy-medium",
  "format": "pcm_s16le",
  "sampleRate": 22050
}

Response:
Content-Type: application/octet-stream
Body: raw audio bytes
```

For streaming TTS: use a WebSocket endpoint `/synthesize/stream` that accepts text and emits audio chunks as they're generated. This is critical for latency — start speaking before the full response is synthesized.

Place at `services/tts/` with its own `requirements.txt`.

### 4.7 Message Flow (End to End)

1. Client captures audio, VAD detects speech, sends audio chunks via WebSocket
2. VoiceChannel accumulates audio chunks in a buffer
3. On `isFinal: true`, send buffer to STT service
4. STT returns transcription text
5. VoiceChannel creates a `NewMessage` and calls `onMessage(jid, message)` — same as WhatsApp
6. Message is stored in SQLite via `storeMessage`
7. Message loop detects new message, triggers `processGroupMessages`
8. Container agent processes, streams response via `onOutput` callback
9. `sendMessage(jid, text)` is called on VoiceChannel
10. VoiceChannel sends text to TTS service
11. TTS audio streams back to client via WebSocket

### 4.8 Typing Indicator → Thinking Indicator

The `setTyping` method maps to voice status events:

```typescript
async setTyping(jid: string, isTyping: boolean): Promise<void> {
  this.sendStatus(jid, isTyping ? 'thinking' : 'listening');
}
```

---

## 5. Persistent Container for Voice

Voice requires low latency. The current container model (spawn per message batch) adds 3-5 seconds of cold start. Voice needs a **warm container**.

### 5.1 Approach

When VoiceChannel connects and a voice session starts, pre-warm a container for the voice group. Keep it alive for the duration of the voice session (not subject to the standard idle timeout). Use the existing IPC message piping (`queue.sendMessage`) to send transcribed text to the warm container. The container's `waitForIpcMessage` loop already handles this.

### 5.2 Integration with GroupQueue

The GroupQueue already supports:
- `sendMessage(groupJid, text)` — pipes text to active container via IPC file
- `closeStdin(groupJid)` — signals container shutdown via `_close` sentinel
- `registerProcess(groupJid, proc, containerName)` — tracks the active container

For voice warm containers:
- On voice session start: call `queue.enqueueMessageCheck(voiceJid)` with a synthetic "session start" message to spin up the container
- While voice is active: all transcribed text goes through `queue.sendMessage`
- On voice session end: call `queue.closeStdin(voiceJid)` to shut down the container

The idle timeout (`IDLE_TIMEOUT`) should be extended or disabled for voice containers. Add a `keepAlive` flag to GroupState, or handle this via a longer `containerConfig.timeout` on the voice group's registration.

---

## 6. Security

### 6.1 Network Security

- **Bind to localhost only** (`127.0.0.1`). Do not expose to `0.0.0.0`.
- External access is through Tailscale/WireGuard tunnel only.
- Optional TLS on the WebSocket for defense in depth.

### 6.2 Authentication

- Pre-shared token in `.env` (`VOICE_AUTH_TOKEN`)
- Token is validated on WebSocket connection before any audio is accepted
- Invalid/missing token → close with code 4001 immediately
- Rate limit: max 3 failed auth attempts per IP per minute

### 6.3 Audio Data Privacy

- Audio is never written to disk. Buffer in memory, transcribe, discard.
- Transcribed text IS stored in SQLite (same as WhatsApp messages) for conversation continuity.
- TTS audio is streamed and discarded — not cached.
- STT/TTS services run locally — no external API calls for voice processing.

### 6.4 Secrets Handling

Follow existing NanoClaw patterns:
- `VOICE_AUTH_TOKEN` stored in `.env`, read via `readEnvFile`
- Never passed to containers or mounted into container filesystems
- Never logged (use `logger` at appropriate levels, redact secrets)

---

## 7. Client Specification (Web)

Build a minimal web client at `clients/voice-web/index.html` (single-file, no build step).

### 7.1 Requirements

- Capture microphone audio via Web Audio API + AudioWorklet
- Run Silero VAD in WebAssembly for speech endpoint detection
- Connect to NanoClaw WebSocket, authenticate with token
- Stream audio chunks during speech
- Play received TTS audio through AudioContext
- Display status (listening / transcribing / thinking / speaking)
- Display text transcripts of both user speech and agent responses
- Show real-time partial transcription for feedback

### 7.2 UI

Minimal, single-screen:
- Large central status indicator (pulsing circle: blue=listening, yellow=thinking, green=speaking)
- Transcript area showing conversation history
- Connection status and latency indicator
- Settings gear for: server URL, auth token, VAD sensitivity

### 7.3 Audio Format

- Capture: PCM 16-bit, 16kHz, mono
- Playback: PCM 16-bit, 22050Hz, mono (Piper default output rate)
- Optional: Opus encoding/decoding for bandwidth efficiency

### 7.4 No External Dependencies

The web client should work offline (once loaded) with no CDN dependencies. Inline any required libraries (Silero VAD WASM, Opus decoder if used). The HTML file is served by NanoClaw's WebSocket server on a separate HTTP endpoint.

---

## 8. Dependencies to Add

### Node.js (host process)

```
ws                    # WebSocket server
```

That's it. The VoiceChannel is thin — STT/TTS are separate services.

### Python (STT service — `services/stt/`)

```
faster-whisper>=1.1.0
flask>=3.0 OR fastapi>=0.115 + uvicorn>=0.32
numpy>=1.26
```

### Python (TTS service — `services/tts/`)

```
piper-tts>=2.0       # OR kokoro>=0.8
flask>=3.0 OR fastapi>=0.115 + uvicorn>=0.32
numpy>=1.26
```

### System (installed via Homebrew on macOS host)

```
python3               # For STT/TTS services
```

---

## 9. File Structure

```
src/
  channels/
    whatsapp.ts       # Existing — no changes
    voice.ts          # NEW — VoiceChannel implementation
  config.ts           # MODIFY — add VOICE_* constants
  index.ts            # MODIFY — multi-channel support
  router.ts           # Existing — already supports multi-channel via routeOutbound
  types.ts            # Existing — Channel interface already defined

services/
  stt/
    server.py         # NEW — faster-whisper HTTP service
    requirements.txt  # NEW
  tts/
    server.py         # NEW — Piper/Kokoro HTTP service
    requirements.txt  # NEW

clients/
  voice-web/
    index.html        # NEW — single-file web client

```

---

## 10. Testing Strategy

### 10.1 Unit Tests

- VoiceChannel: mock WebSocket connections, verify `onMessage` is called with correct `NewMessage` structure after receiving audio + transcription
- Auth: verify token validation, rejection on invalid token
- JID ownership: verify `ownsJid` returns true for `voice:*@local`, false for WhatsApp JIDs

### 10.2 Integration Tests

- Full pipeline: send audio via WebSocket → verify transcription → verify container receives prompt → verify TTS audio returned
- Multi-channel: send message via WhatsApp to group X, verify voice channel for group X sees the same context
- Warm container: verify container stays alive across multiple voice utterances

### 10.3 Manual Testing

```bash
# Start STT service
cd services/stt && python server.py

# Start TTS service
cd services/tts && python server.py

# Start NanoClaw with voice enabled
VOICE_ENABLED=true VOICE_AUTH_TOKEN=test123 npm run dev

# Open web client
open http://localhost:8443
```

---

## 11. What NOT to Build

- **No wake word detection on server side.** VAD and wake word run on the client only.
- **No voice-to-voice model (speech-to-speech).** Use the STT → text → LLM → text → TTS pipeline. Voice-to-voice models (GPT-4o Realtime, etc.) bypass the existing NanoClaw architecture and don't give you container isolation.
- **No MQTT broker.** WebSocket is the transport. MQTT is only relevant if you later add hardware satellites (ESP32), which is a separate feature.
- **No user management / multi-user auth.** Single user, single token. Multi-user comes later.
- **No mobile app.** Web client first. Native app is a separate project.
- **No modification to the container image.** Voice processing happens on the host, not inside containers. The agent receives text and returns text, same as WhatsApp.

---

## 12. Success Criteria

1. User speaks into microphone on phone browser, agent responds with voice, total round-trip under 3 seconds (warm container)
2. Voice and WhatsApp channels run simultaneously without interference
3. Voice session shares group context — conversation history, CLAUDE.md, scheduled tasks all work
4. No audio data persists on disk — only transcribed text in SQLite
5. Connection is authenticated and encrypted (token + Tailscale)
6. Existing WhatsApp tests pass unchanged
7. `npm run build` compiles with no errors
8. Voice can be disabled entirely via `VOICE_ENABLED=false` with zero runtime cost

---

## 13. Implementation Order

1. **STT service** (`services/stt/`) — get transcription working standalone
2. **TTS service** (`services/tts/`) — get synthesis working standalone
3. **VoiceChannel** (`src/channels/voice.ts`) — WebSocket server, auth, audio buffering, STT/TTS integration
4. **Orchestrator changes** (`src/index.ts`) — multi-channel array, route outbound via `routeOutbound`
5. **Config** (`src/config.ts`) — add VOICE_* constants
6. **Web client** (`clients/voice-web/index.html`) — microphone capture, VAD, WebSocket connection, audio playback
7. **Warm container support** — extend GroupQueue for persistent voice containers
8. **Testing** — unit + integration + manual end-to-end
