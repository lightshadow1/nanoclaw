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

  private async transcribe(audio: Buffer): Promise<{ text: string; confidence: number } | null> {
    try {
      // Convert PCM to WAV for Smallest.ai Waves API (Pulse model)
      const wav = this.pcmToWav(audio, 16000, 1);
      
      const res = await fetch(
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
    const res = await fetch(
      'https://waves-api.smallest.ai/api/v1/lightning/get_speech',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.smallestApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text,
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

    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
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
```

Sync to container env: `cp .env data/env/env`

**For remote access via Tailscale:**
- Keep `VOICE_HOST=127.0.0.1` (localhost)
- Access from remote machine using Tailscale IP (e.g., `http://100.64.1.5:8443`)
- Tailscale proxies the connection securely through encrypted tunnel

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
- First request: 1-2 seconds (Smallest.ai API cold start)
- Subsequent requests: <100ms

## Warm Container Support

Voice needs low latency. The standard container model (spawn per message batch) adds 3-5 seconds of cold start. When a voice client connects, the VoiceChannel should pre-warm a container.

The GroupQueue already supports message piping to active containers via `queue.sendMessage(groupJid, text)`. For voice:

1. On first authenticated voice connection: call `queue.enqueueMessageCheck(voiceJid)` with a synthetic greeting to spin up the container
2. While voice is active: transcribed text goes through `queue.sendMessage` if a container is running, otherwise through the normal message loop
3. On last voice client disconnect: optionally `queue.closeStdin(voiceJid)` to release the container

The voice group registration has `requiresTrigger: false`, so the message loop processes all voice messages automatically.

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

## Troubleshooting

### STT service not responding
```bash
curl -X POST http://127.0.0.1:8700/health
# Should return {"status": "ok"}
```

### TTS service not responding
```bash
curl -X POST http://127.0.0.1:8701/health
# Should return {"status": "ok"}
```

### No audio in browser
- Check browser permissions (microphone access)
- Verify WebSocket connects: open browser dev tools → Network → WS
- Ensure `VOICE_AUTH_TOKEN` matches between `.env` and the web client

### Voice channel not starting
- Verify `VOICE_ENABLED=true` in `.env`
- Check port isn't in use: `lsof -i :8443`
- Check logs: `tail -f logs/nanoclaw.log | grep -i voice`

### High latency
- Use `small` Whisper model (faster) instead of `medium` or `large`
- Ensure TTS model is preloaded (first request may be slow)
- Check that STT/TTS services are running on the same machine (not over network)
