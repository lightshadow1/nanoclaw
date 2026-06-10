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

  async sendMessage(jid: string, text: string): Promise<string | null> {
    if (!this.ownsJid(jid)) return null;

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
    return null;
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
      // Convert PCM to WAV for Smallest.ai API
      const wav = this.pcmToWav(audio, 16000, 1);
      
      const formData = new FormData();
      const blob = new Blob([wav], { type: 'audio/wav' });
      formData.append('audio', blob, 'audio.wav');
      formData.append('language', 'en');

      const res = await fetch('https://api.smallest.ai/api/Transcribe', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.smallestApiKey}` },
        body: formData,
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Smallest.ai returned ${res.status}: ${errorText}`);
      }

      const result = await res.json() as { text: string };
      return { text: result.text, confidence: 1.0 };
    } catch (err) {
      logger.error({ err }, 'Smallest.ai transcription failed');
      return null;
    }
  }

  private async synthesizeWithSmallest(text: string): Promise<Buffer> {
    const res = await fetch('https://api.smallest.ai/api/Speak', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.smallestApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        voice_id: 'default',
        sample_rate: 24000,
        format: 'pcm',
      }),
    });

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
