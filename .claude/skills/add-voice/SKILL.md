---
name: add-voice
description: Add a real-time voice interface to NanoClaw. Lets the user speak to their agent via WebSocket from a phone or laptop browser, with local STT (faster-whisper) and TTS (Piper/Kokoro). Use this skill when the user mentions voice, speech, talking to the agent, microphone, audio interface, or hands-free interaction — even if they don't say "voice channel" explicitly.
---

# Add Voice Channel

This skill adds real-time voice interaction to NanoClaw. Audio streams bidirectionally over WebSocket — the user's voice is transcribed server-side via faster-whisper, routed through NanoClaw's existing orchestrator, and the agent's text response is synthesized back to speech and streamed to a web client.

The voice channel is a peer to WhatsApp/Telegram, not a replacement. Both run simultaneously. A voice session maps to a configured group context (shared CLAUDE.md, shared session).

## Architecture

```
┌──────────────┐     Tailscale/WireGuard      ┌──────────────────────────────┐
│  Web Client   │◄──────── WSS ──────────────►│  NanoClaw Host               │
│  (Phone/Web)  │     encrypted tunnel         │                              │
│               │                              │  ┌────────────────────────┐  │
│  mic → VAD ───┼── audio chunks (pcm) ──────►│  │  VoiceChannel          │  │
│               │                              │  │  (WebSocket server)     │  │
│  speaker ◄────┼── audio chunks (pcm) ◄──────│  │                        │  │
│               │                              │  │  audio → Smallest.ai   │  │
│               │                              │  │  text  ← Smallest.ai   │  │
│               │                              │  └──────────┬─────────────┘  │
│               │                              │             │ Channel iface  │
│               │                              │             ▼                │
│               │                              │  ┌────────────────────────┐  │
│               │                              │  │  Orchestrator          │  │
│               │                              │  │  GroupQueue / IPC      │  │
│               │                              │  └────────────────────────┘  │
└──────────────┘                              └──────────────────────────────┘
```

The VoiceChannel is a TypeScript WebSocket server that implements the `Channel` interface. All audio processing (STT/TTS) is handled by Smallest.ai API calls — no local services required.

## Prerequisites

### 1. Ask the User

Before implementing, ask:

1. **Smallest.ai API key**: Do they have one? Get it from https://www.smallest.ai/
2. **Voice group**: Which group should voice map to? Usually `main`.
3. **Port**: WebSocket port (default: `8443`)
4. **Network setup**: Will they access from the same machine or remotely (via Tailscale)?

### 2. Install Node Dependencies

```bash
npm install ws
npm install -D @types/ws
```

No Python dependencies required — all audio processing is handled by Smallest.ai API.

## Implementation

Follow these steps in order. Read the referenced file before modifying it.

### Step 1: Configuration

Read `src/config.ts` and add voice config exports near the other channel configs:

```typescript
// Voice channel
const voiceEnv = readEnvFile([
  'VOICE_ENABLED', 'VOICE_PORT', 'VOICE_HOST', 'VOICE_GROUP',
  'SMALLEST_AI_API_KEY',
]);
export const VOICE_ENABLED =
  (process.env.VOICE_ENABLED || voiceEnv.VOICE_ENABLED) === 'true';
export const VOICE_PORT = parseInt(
  process.env.VOICE_PORT || voiceEnv.VOICE_PORT || '8443', 10,
);
export const VOICE_HOST =
  process.env.VOICE_HOST || voiceEnv.VOICE_HOST || '127.0.0.1';
export const VOICE_GROUP =
  process.env.VOICE_GROUP || voiceEnv.VOICE_GROUP || 'main';
// Smallest.ai API key — read at runtime like ANTHROPIC_API_KEY
// Do NOT export as constant to keep it out of process environment
```

Also add `VOICE_AUTH_TOKEN` and `SMALLEST_AI_API_KEY` to the secrets that are read at runtime (not exported as constants — follow the pattern used for `ANTHROPIC_API_KEY` if one exists, or read them in the VoiceChannel constructor via `readEnvFile`).

### Step 2: VoiceChannel

Create `src/channels/voice.ts` implementing the `Channel` interface. Use `src/channels/whatsapp.ts` as the structural reference and `src/channels/telegram.ts` for the Channel pattern.

```typescript
import { randomUUID } from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { WebSocket, WebSocketServer } from 'ws';

import { ASSISTANT_NAME } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  Channel, NewMessage, OnChatMetadata, OnInboundMessage, RegisteredGroup,
} from '../types.js';

export interface VoiceChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  port: number;
  host: string;
  groupJid: string; // e.g. "voice:main@local"
}

export class VoiceChannel implements Channel {
  name = 'voice';

  private wss: WebSocketServer | null = null;
  private httpServer: http.Server | null = null;
  private opts: VoiceChannelOpts;
  private activeClients = new Map<string, WebSocket>(); // sessionId → ws
  private authToken: string;
  private smallestApiKey: string;

  constructor(opts: VoiceChannelOpts) {
    this.opts = opts;
    // Read secrets at construction — stays in memory, not exported
    const secrets = readEnvFile(['VOICE_AUTH_TOKEN', 'SMALLEST_AI_API_KEY']);
    this.authToken = process.env.VOICE_AUTH_TOKEN || secrets.VOICE_AUTH_TOKEN || '';
    this.smallestApiKey = process.env.SMALLEST_AI_API_KEY || secrets.SMALLEST_AI_API_KEY || '';
    
    if (!this.authToken) {
      logger.warn('VOICE_AUTH_TOKEN not set — voice connections will be rejected');
    }
    if (!this.smallestApiKey) {
      logger.warn('SMALLEST_AI_API_KEY not set — voice channel will fail');
    }
  }

  async connect(): Promise<void> {
    this.httpServer = http.createServer((req, res) => {
      // Serve web client on GET /
      if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        this.serveWebClient(res);
        return;
      }
      res.writeHead(404);
      res.end();
    });

    this.wss = new WebSocketServer({ server: this.httpServer, path: '/voice' });

    this.wss.on('connection', (ws) => {
      let authenticated = false;
      let sessionId = '';

      // Auth timeout — must authenticate within 5 seconds
      const authTimeout = setTimeout(() => {
        if (!authenticated) {
          ws.close(4001, 'Auth timeout');
        }
      }, 5000);

      ws.on('message', async (data) => {
        try {
          const msg = JSON.parse(data.toString());

          if (!authenticated) {
            if (msg.type === 'auth' && msg.token === this.authToken) {
              authenticated = true;
              sessionId = randomUUID();
              clearTimeout(authTimeout);
              this.activeClients.set(sessionId, ws);
              ws.send(JSON.stringify({ type: 'auth_ok', sessionId }));
              this.sendStatus(ws, 'listening');
              logger.info({ sessionId }, 'Voice client authenticated');
            } else {
              ws.close(4001, 'Invalid token');
            }
            return;
          }

          // Handle audio frames
          if (msg.type === 'audio' && msg.isFinal) {
            this.sendStatus(ws, 'transcribing');
            const audioBuffer = Buffer.from(msg.data, 'base64');
            const transcript = await this.transcribe(audioBuffer);

            if (transcript && transcript.text.trim()) {
              this.sendStatus(ws, 'thinking');
              // Send partial transcript to client for display
              ws.send(JSON.stringify({
                type: 'transcript', text: transcript.text, isFinal: true,
                confidence: transcript.confidence,
              }));

              // Deliver to orchestrator as a normal message
              const timestamp = new Date().toISOString();
              const chatJid = this.opts.groupJid;
              this.opts.onChatMetadata(chatJid, timestamp, 'Voice');
              this.opts.onMessage(chatJid, {
                id: randomUUID(),
                chat_jid: chatJid,
                sender: 'voice-user',
                sender_name: 'User',
                content: transcript.text,
                timestamp,
                is_from_me: false,
              });
            } else {
              this.sendStatus(ws, 'listening');
            }
          }
        } catch (err) {
          logger.error({ err }, 'Error processing voice message');
        }
      });

      ws.on('close', () => {
        clearTimeout(authTimeout);
        if (sessionId) {
          this.activeClients.delete(sessionId);
          logger.info({ sessionId }, 'Voice client disconnected');
        }
      });
    });

    return new Promise<void>((resolve) => {
      this.httpServer!.listen(this.opts.port, this.opts.host, () => {
        logger.info(
          { port: this.opts.port, host: this.opts.host },
          'Voice channel listening',
        );
        console.log(`\n  Voice: http://${this.opts.host}:${this.opts.port}`);
        console.log(`  WebSocket: ws://${this.opts.host}:${this.opts.port}/voice\n`);
        resolve();
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.ownsJid(jid)) return;

    // Synthesize speech and send to all active clients
    try {
      const audioBuffer = await this.synthesizeWithSmallest(text);

      for (const [, ws] of this.activeClients) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'audio_response',
            text,
            data: audioBuffer.toString('base64'),
            format: 'pcm_s16le',
            sampleRate: 24000,
            isFinal: true,
          }));
          this.sendStatus(ws, 'listening');
        }
      }
    } catch (err) {
      logger.error({ err }, 'TTS synthesis failed');
      // Fall back to text-only
      for (const [, ws] of this.activeClients) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'text_response', text }));
          this.sendStatus(ws, 'listening');
        }
      }
    }
  }

  
  isConnected(): boolean {
    return this.wss !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('voice:') && jid.endsWith('@local');
  }

  async disconnect(): Promise<void> {
    for (const [, ws] of this.activeClients) {
      ws.close(1000, 'Server shutting down');
    }
    this.activeClients.clear();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
    }
    logger.info('Voice channel stopped');
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    for (const [, ws] of this.activeClients) {
      if (ws.readyState === WebSocket.OPEN) {
        this.sendStatus(ws, isTyping ? 'thinking' : 'listening');
      }
    }
  }

  // --- Private helpers ---

  private sendStatus(ws: WebSocket, state: string): void {
    ws.send(JSON.stringify({ type: 'status', state }));
  }

  private async fetchWithRetry(
    url: string,
    opts: RequestInit,
    maxAttempts = 3,
  ): Promise<Response> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fetch(url, opts);
      } catch (err) {
        lastErr = err;
        const cause = (err as { cause?: { code?: string } }).cause;
        const isTransient = cause?.code === 'EAI_AGAIN' ||
          cause?.code === 'ECONNRESET' || cause?.code === 'ETIMEDOUT';
        if (!isTransient || attempt === maxAttempts) throw err;
        const delay = attempt * 500;
        logger.warn({ attempt, delay, code: cause?.code }, 'Smallest.ai fetch transient error, retrying');
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastErr;
  }

  private async transcribe(audio: Buffer): Promise<{ text: string; confidence: number } | null> {
    try {
      // Convert PCM to WAV for Smallest.ai Waves API (Pulse model)
      const wav = this.pcmToWav(audio, 16000, 1);
      
      const res = await this.fetchWithRetry(
        'https://waves-api.smallest.ai/api/v1/pulse/get_text?model=pulse&language=en',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.smallestApiKey}`,
            'Content-Type': 'audio/wav',
          },
          body: wav,
        },
      );

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Smallest.ai returned ${res.status}: ${errorText}`);
      }

      const result = await res.json() as { transcription: string };
      return { text: result.transcription, confidence: 1.0 };
    } catch (err) {
      logger.error({ err }, 'Smallest.ai transcription failed');
      return null;
    }
  }

  private async synthesizeWithSmallest(text: string): Promise<Buffer> {
    // Lightning model has max 250 chars per request - chunk long text
    const chunks = this.chunkText(text, 250);
    const audioBuffers: Buffer[] = [];

    for (const chunk of chunks) {
      const res = await this.fetchWithRetry(
        'https://waves-api.smallest.ai/api/v1/lightning/get_speech',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.smallestApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text: chunk,
            voice_id: 'emily',
            sample_rate: 24000,
            add_wav_header: false,
          }),
        },
      );

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Smallest.ai TTS returned ${res.status}: ${errorText}`);
      }

      audioBuffers.push(Buffer.from(await res.arrayBuffer()));
    }

    return Buffer.concat(audioBuffers);
  }

  private chunkText(text: string, maxChunkSize: number): string[] {
    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxChunkSize) {
        chunks.push(remaining);
        break;
      }

      // Look for punctuation within last 50 chars of max chunk size
      let chunkEnd = maxChunkSize;
      const punctuation = '.,:;!?';
      let foundPunct = false;

      for (let i = chunkEnd; i > Math.max(chunkEnd - 50, 0); i--) {
        if (i < remaining.length && punctuation.includes(remaining[i])) {
          chunkEnd = i + 1; // Include the punctuation
          foundPunct = true;
          break;
        }
      }

      // If no punctuation, look for space
      if (!foundPunct) {
        for (let i = chunkEnd; i > Math.max(chunkEnd - 50, 0); i--) {
          if (i < remaining.length && remaining[i] === ' ') {
            chunkEnd = i;
            break;
          }
        }
      }

      chunks.push(remaining.slice(0, chunkEnd).trim());
      remaining = remaining.slice(chunkEnd).trim();
    }

    return chunks;
  }

  private pcmToWav(pcm: Buffer, sampleRate: number, channels: number): Buffer {
    const dataSize = pcm.length;
    const header = Buffer.alloc(44);

    // RIFF header
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);

    // fmt chunk
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * channels * 2, 28);
    header.writeUInt16LE(channels * 2, 32);
    header.writeUInt16LE(16, 34);

    // data chunk
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    return Buffer.concat([header, pcm]);
  }

  private serveWebClient(res: http.ServerResponse): void {
    const clientPath = path.resolve(process.cwd(), 'clients/voice-web/index.html');
    try {
      const html = fs.readFileSync(clientPath, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><h1>Voice Client</h1><p>Web client not found at clients/voice-web/index.html</p></body></html>');
    }
  }
}
```

### Step 3: Multi-Channel Refactoring

The current `src/index.ts` directly references `whatsapp` throughout. We need to refactor to support multiple channels.

#### 3a. Add channel utilities

At the top of `src/index.ts`, after the `whatsapp` declaration (around line 51):

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

**Add imports at the top of `src/index.ts`:**

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

**Update `getAvailableGroups` filter to include voice JIDs:**

```typescript
.filter((c) => c.jid !== '__group_sync__' &&
  (c.jid.endsWith('@g.us') || c.jid.startsWith('voice:')))
```

*Note: Removed forward reference to `tg:` prefix since Telegram isn't implemented yet.*

### Step 5: Web Client

Create `clients/voice-web/index.html`. Read `references/web-client.md` for the full single-file implementation.

The web client handles:
- Microphone capture via Web Audio API (PCM 16-bit, 16kHz, mono)
- Voice Activity Detection (simple energy-based)
- WebSocket connection with token authentication
- Audio playback of TTS responses (24kHz from Smallest.ai)
- Status display (listening / transcribing / thinking / speaking)
- Conversation transcript

### Step 6: Environment Variables

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

# Optional: TLS/SSL with Tailscale HTTPS (recommended for remote access)
# VOICE_TLS_CERT=/var/lib/tailscale/certs/<hostname>.ts.net.crt
# VOICE_TLS_KEY=/var/lib/tailscale/certs/<hostname>.ts.net.key
```

Sync to container env: `cp .env data/env/env`

**For remote access via Tailscale (HTTP):**
- Keep `VOICE_HOST=127.0.0.1` (localhost)
- Access from remote machine using Tailscale IP (e.g., `http://100.64.1.5:8443`)
- Tailscale proxies the connection securely through encrypted tunnel

**For HTTPS with Tailscale certificates (recommended):**
1. Enable HTTPS in your Tailscale admin console: https://tailscale.com/docs/how-to/set-up-https-certificates
2. On the Linux machine, certificates are automatically provisioned at:
   - `/var/lib/tailscale/certs/<hostname>.ts.net.crt`
   - `/var/lib/tailscale/certs/<hostname>.ts.net.key`
3. Set environment variables:
   ```bash
   VOICE_TLS_CERT=/var/lib/tailscale/certs/<hostname>.ts.net.crt
   VOICE_TLS_KEY=/var/lib/tailscale/certs/<hostname>.ts.net.key
   VOICE_HOST=0.0.0.0  # Bind to all interfaces for Tailscale hostname
   ```
4. Access via `https://<hostname>.ts.net:8443` (no browser certificate warnings!)

### Step 7: Build and Test

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

**Latency expectations:**
- First request: ~500ms (with container pre-warming)
- Subsequent requests: ~200-500ms

### Step 8: Smoke Tests

Before full pipeline testing, validate the Smallest.ai API integration:

**Test STT API:**
```bash
# Create a test WAV file (silence, 1 second, 16kHz mono)
ffmpeg -f lavfi -i anullsrc=r=16000:cl=mono -t 1 -f wav test.wav

# Test the Pulse API
curl -X POST \
  'https://waves-api.smallest.ai/api/v1/pulse/get_text?model=pulse&language=en' \
  -H "Authorization: Bearer $SMALLEST_AI_API_KEY" \
  -H "Content-Type: audio/wav" \
  --data-binary @test.wav

# Expected: {"transcription": ""} or similar
```

**Test TTS API:**
```bash
curl -X POST \
  'https://waves-api.smallest.ai/api/v1/lightning/get_speech' \
  -H "Authorization: Bearer $SMALLEST_AI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text":"Hello world","voice_id":"emily","sample_rate":24000,"add_wav_header":false}' \
  --output test.pcm

# Should produce test.pcm file with audio data
```

## Warm Container Support

Voice needs low latency. The standard container model (spawn per message batch) adds 3-5 seconds of cold start. **IMPLEMENTED:** The VoiceChannel pre-warms a container on first client connection.

**Implementation:**
1. Add `warmContainer?: (groupJid: string) => void` to `VoiceChannelOpts`
2. In `index.ts`, pass `warmContainer: (jid) => queue.enqueueMessageCheck(jid)` when creating VoiceChannel
3. On first authenticated connection, call `this.opts.warmContainer(this.opts.groupJid)` if `activeClients.size === 1`

```typescript
// In voice.ts after authentication
if (this.opts.warmContainer && this.activeClients.size === 1) {
  logger.info({ groupJid: this.opts.groupJid }, 'Pre-warming container for voice');
  this.opts.warmContainer(this.opts.groupJid);
}
```

The voice group registration has `requiresTrigger: false`, so the message loop processes all voice messages automatically.

## Production Fixes & Optimizations

### 1. VAD (Voice Activity Detection) Tuning

**Problem:** VAD too sensitive (false positives) or too slow (cuts off start of speech)

**Solution:** Balanced settings in `clients/voice-web/index.html`:
```javascript
const SILENCE_THRESHOLD = 0.01;  // Sensitive enough to catch speech start
const SILENCE_FRAMES_TO_STOP = 6; // ~0.6s silence before sending
const MIN_SPEECH_FRAMES = 1;      // Start recording immediately
```

**Tuning guide:**
- Lower `SILENCE_THRESHOLD` (0.008-0.012) = more sensitive
- Higher `MIN_SPEECH_FRAMES` (2-4) = less false positives
- Higher `SILENCE_FRAMES_TO_STOP` (5-8) = captures pauses between words

### 2. TTS Text Sanitization

**Problem:** TTS reads "asterisk", emoji names, and long URLs

**Solution:** `sanitizeForTTS()` method in voice.ts:
```typescript
private sanitizeForTTS(text: string): string {
  return text
    // Remove Sources/References sections entirely
    .replace(/\*?Sources?\*?:?[\s\S]*$/i, '')
    .replace(/\*?References?\*?:?[\s\S]*$/i, '')
    // Remove all URLs
    .replace(/https?:\/\/[^\s)]+/g, '')
    // Remove ALL emojis (including variation selectors)
    .replace(/[\u{1F000}-\u{1FFFF}...]/gu, '')
    // Remove all asterisks
    .replace(/\*+/g, '')
    // Convert newlines to periods for natural flow
    .replace(/\n/g, '. ')
    // Clean up
    .trim();
}
```

### 3. Text Chunking for TTS

**Problem:** Lightning model has 250-char limit, returns 400 error

**Solution:** `chunkText()` method splits at natural boundaries:
- Prefers punctuation (`.,:;!?`)
- Falls back to spaces
- Concatenates audio buffers

### 4. Concise Voice Responses

**Problem:** Agent gives long, detailed responses with citations

**Solution:** Added voice-specific guidelines to `groups/main/CLAUDE.md`:
```markdown
## Voice Interface Guidelines

When responding to voice messages (from `voice:main@local`):
- Give direct, spoken-word answers (2-3 sentences max)
- Skip citations, sources, and URLs entirely
- Avoid lists, bullet points, and structured formatting
- Speak naturally as if having a conversation
```

### 5. API Endpoint Fixes

**Problem:** Using incorrect Smallest.ai endpoints (404 errors)

**Correct endpoints:**
- **STT:** `https://waves-api.smallest.ai/api/v1/pulse/get_text?model=pulse&language=en`
  - Headers: `Authorization: Bearer <key>`, `Content-Type: audio/wav`
  - Body: raw WAV data
  - Response: `{ transcription: string }`

- **TTS:** `https://waves-api.smallest.ai/api/v1/lightning/get_speech`
  - Body: `{ text, voice_id: 'emily', sample_rate: 24000, add_wav_header: false }`
  - Returns: raw PCM audio

### 6. Retry Logic for Network Issues

**Problem:** Transient DNS failures (EAI_AGAIN) at startup

**Solution:** `fetchWithRetry()` wrapper:
- Retries up to 3 times on `EAI_AGAIN`, `ECONNRESET`, `ETIMEDOUT`
- Exponential backoff: 500ms, 1000ms, 1500ms
- Used for all Smallest.ai API calls

### 7. Null Safety for Transcriptions

**Problem:** Empty transcriptions cause `undefined.trim()` errors

**Solution:**
```typescript
if (transcript && transcript.text && transcript.text.trim()) {
  // Process transcript
}
```

### 8. Visual Recording Feedback

Added red pulsing orb (🔴) when actively recording to show VAD status

## Security Notes

- **Bind to localhost only** (`127.0.0.1`). External access via Tailscale/WireGuard.
- **Pre-shared token** in `.env` — validated on WebSocket connect before any audio is accepted.
- **Audio never hits disk** — buffered in memory, transcribed, discarded.
- **Transcribed text IS stored** in SQLite (same as WhatsApp messages) for conversation continuity.
- **STT/TTS services run locally** — no external API calls for voice processing.

## What NOT to Build

- No wake word detection on server (VAD runs on the client)
- No voice-to-voice model (use STT → LLM → TTS pipeline to keep container isolation)
- No MQTT broker (WebSocket is the transport)
- No multi-user auth (single user, single token)
- No mobile app (web client first)
- No container image changes (voice processing is on the host, agents receive/return text)

## Advanced Configuration

### Rate Limiting

Smallest.ai has rate limits on their API. If you encounter 429 errors:
- Free tier: ~100 requests/min
- Paid tier: Higher limits (check your plan)

**Mitigation:**
- The retry logic already handles transient failures
- Consider adding request queuing for high-traffic scenarios
- Monitor usage via Smallest.ai dashboard

### Multi-Client Behavior

**Current implementation:**
- Multiple clients can connect simultaneously
- All clients receive broadcast responses (not isolated sessions)
- Container pre-warms only on first client connection

**For isolated sessions:**
- Use different `VOICE_GROUP` values (e.g., `voice:alice`, `voice:bob`)
- Each group gets its own container and context

### Voice Customization

**Change TTS voice:**
Edit `src/channels/voice.ts` line ~290:
```typescript
voice_id: 'emily',  // Options: emily, jessica, michael, etc.
```

**Adjust audio quality:**
```typescript
sample_rate: 24000,  // Options: 16000, 22050, 24000, 44100
```

**Change VAD sensitivity:**
Edit `clients/voice-web/index.html` lines 110-112 and refresh browser.

## Troubleshooting

### Smallest.ai API Issues

**401 Unauthorized:**
- Verify `SMALLEST_AI_API_KEY` is set correctly in `.env`
- Check key hasn't expired at https://www.smallest.ai/
- Ensure key is synced to `data/env/env` if using containers

**404 Not Found:**
- Verify you're using Waves API endpoints (not legacy API)
- Check endpoint URLs match exactly as documented

**400 Bad Request:**
- Text too long: Should be chunked at 250 chars (already implemented)
- Invalid audio format: Must be WAV, 16kHz, mono for STT

**429 Rate Limited:**
- Wait and retry (automatic with `fetchWithRetry`)
- Upgrade Smallest.ai plan if hitting limits frequently

### No audio in browser
- **Check browser permissions:** Allow microphone access
- **Verify WebSocket:** Open dev tools → Network → WS, should show connected
- **Check auth token:** Must match between `.env` and web client
- **Test locally first:** Use `http://localhost:8443` before remote access

### Voice channel not starting
- **Check VOICE_ENABLED:** Must be `true` in `.env`
- **Port conflict:** Run `lsof -i :8443` to check if port is in use
- **Check logs:** `tail -f logs/nanoclaw.log | grep -i voice`
- **TLS issues:** If using TLS, verify cert/key paths exist and are readable

### Transcription issues

**Empty transcriptions:**
- VAD might be too sensitive (increase `SILENCE_THRESHOLD`)
- Audio too quiet (check microphone levels)
- Background noise triggering false positives

**Cut-off speech:**
- Decrease `MIN_SPEECH_FRAMES` to start recording faster
- Increase `SILENCE_FRAMES_TO_STOP` to allow pauses

**Garbled/incorrect transcriptions:**
- Check audio quality (noise suppression in browser helps)
- Verify sample rate is 16kHz for STT
- Test with clear, louder speech first

### High latency

**First message slow (>3s):**
- Container pre-warming should eliminate this
- Check `warmContainer` is called on connection (see logs)

**All messages slow:**
- Network latency to Smallest.ai API
- Test API directly with curl to isolate issue
- Check retry logic isn't triggering (would log warnings)

**TTS playback stuttering:**
- Browser audio buffering issues
- Try reducing text length (more chunks = smoother streaming effect)
- Check network bandwidth

### DNS/Network failures

**EAI_AGAIN errors:**
- Retry logic should handle this automatically
- If persistent, check DNS configuration: `cat /etc/resolv.conf`
- Workaround: Add to `/etc/hosts`: `3.33.178.96 waves-api.smallest.ai`

## Post-Implementation Checklist

✅ Voice channel connects and authenticates
✅ Speech is transcribed correctly
✅ Agent responds with synthesized voice
✅ Container pre-warms on connection (fast responses)
✅ VAD tuned for your microphone/environment
✅ Text sanitization working (no asterisks/URLs spoken)
✅ CLAUDE.md updated with voice guidelines
✅ Tested from remote device via Tailscale
✅ Error handling and retry logic validated
✅ Documentation updated with any custom changes
