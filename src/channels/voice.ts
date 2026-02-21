import { randomUUID } from 'crypto';
import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import { WebSocket, WebSocketServer } from 'ws';

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  Channel,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface VoiceChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  port: number;
  host: string;
  groupJid: string; // e.g. "voice:main@local"
  tlsCert?: string; // path to TLS cert file
  tlsKey?: string;  // path to TLS key file
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
    const secrets = readEnvFile(['VOICE_AUTH_TOKEN', 'SMALLEST_AI_API_KEY']);
    this.authToken = process.env.VOICE_AUTH_TOKEN || secrets.VOICE_AUTH_TOKEN || '';
    this.smallestApiKey =
      process.env.SMALLEST_AI_API_KEY || secrets.SMALLEST_AI_API_KEY || '';

    if (!this.authToken) {
      logger.warn('VOICE_AUTH_TOKEN not set — voice connections will be rejected');
    }
    if (!this.smallestApiKey) {
      logger.warn('SMALLEST_AI_API_KEY not set — voice channel will fail');
    }
  }

  async connect(): Promise<void> {
    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
      if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        this.serveWebClient(res);
        return;
      }
      res.writeHead(404);
      res.end();
    };

    const { tlsCert, tlsKey } = this.opts;
    if (tlsCert && tlsKey) {
      const cert = fs.readFileSync(tlsCert);
      const key = fs.readFileSync(tlsKey);
      this.httpServer = https.createServer({ cert, key }, handler);
    } else {
      this.httpServer = http.createServer(handler);
    }

    const protocol = tlsCert && tlsKey ? 'https' : 'http';
    const wsProtocol = tlsCert && tlsKey ? 'wss' : 'ws';

    this.wss = new WebSocketServer({ server: this.httpServer, path: '/voice' });

    this.wss.on('connection', (ws) => {
      let authenticated = false;
      let sessionId = '';

      const authTimeout = setTimeout(() => {
        if (!authenticated) ws.close(4001, 'Auth timeout');
      }, 5000);

      ws.on('message', async (data) => {
        try {
          const msg = JSON.parse(data.toString()) as {
            type: string;
            token?: string;
            data?: string;
            isFinal?: boolean;
          };

          if (!authenticated) {
            if (msg.type === 'auth' && msg.token === this.authToken) {
              authenticated = true;
              sessionId = randomUUID();
              clearTimeout(authTimeout);
              this.activeClients.set(sessionId, ws);
              ws.send(JSON.stringify({ type: 'auth_ok', sessionId }));
              this.sendStatus(ws, 'listening');
              logger.info({ sessionId }, 'Voice client authenticated');

              // Register chat so the orchestrator knows this group exists
              const timestamp = new Date().toISOString();
              this.opts.onChatMetadata(
                this.opts.groupJid,
                timestamp,
                `Voice (${this.opts.groupJid.split(':')[1]?.split('@')[0]})`,
                'voice',
                true,
              );
            } else {
              ws.close(4001, 'Invalid token');
            }
            return;
          }

          if (msg.type === 'audio' && msg.isFinal && msg.data) {
            this.sendStatus(ws, 'transcribing');
            const audioBuffer = Buffer.from(msg.data, 'base64');
            const transcript = await this.transcribe(audioBuffer);

            if (transcript && transcript.text && transcript.text.trim()) {
              this.sendStatus(ws, 'thinking');
              ws.send(
                JSON.stringify({
                  type: 'transcript',
                  text: transcript.text,
                  isFinal: true,
                }),
              );

              const timestamp = new Date().toISOString();
              const chatJid = this.opts.groupJid;
              const newMsg: NewMessage = {
                id: randomUUID(),
                chat_jid: chatJid,
                sender: 'voice-user',
                sender_name: 'User',
                content: transcript.text,
                timestamp,
                is_from_me: false,
              };
              this.opts.onMessage(chatJid, newMsg);
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
          { port: this.opts.port, host: this.opts.host, tls: !!(tlsCert && tlsKey) },
          'Voice channel listening',
        );
        console.log(`\n  Voice UI: ${protocol}://${this.opts.host}:${this.opts.port}`);
        console.log(`  WebSocket: ${wsProtocol}://${this.opts.host}:${this.opts.port}/voice\n`);
        resolve();
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.ownsJid(jid)) return;

    try {
      const audioBuffer = await this.synthesize(text);
      for (const [, ws] of this.activeClients) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: 'audio_response',
              text,
              data: audioBuffer.toString('base64'),
              format: 'pcm_s16le',
              sampleRate: 24000,
              isFinal: true,
            }),
          );
          this.sendStatus(ws, 'listening');
        }
      }
    } catch (err) {
      logger.error({ err }, 'TTS synthesis failed — falling back to text');
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

  private async transcribe(
    audio: Buffer,
  ): Promise<{ text: string } | null> {
    try {
      const wav = this.pcmToWav(audio, 16000, 1);

      const res = await this.fetchWithRetry(
        'https://waves-api.smallest.ai/api/v1/pulse/get_text?model=pulse&language=en',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.smallestApiKey}`,
            'Content-Type': 'audio/wav',
          },
          body: wav,
        },
      );

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Smallest.ai STT returned ${res.status}: ${errorText}`);
      }

      const result = (await res.json()) as { transcription?: string };
      if (!result.transcription) {
        return null;
      }
      return { text: result.transcription };
    } catch (err) {
      logger.error({ err }, 'Smallest.ai transcription failed');
      return null;
    }
  }

  private async synthesize(text: string): Promise<Buffer> {
    // Lightning model has max 250 chars per request
    const chunks = this.chunkText(text, 250);
    const audioBuffers: Buffer[] = [];

    for (const chunk of chunks) {
      const res = await this.fetchWithRetry(
        'https://waves-api.smallest.ai/api/v1/lightning/get_speech',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.smallestApiKey}`,
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
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * channels * 2, 28);
    header.writeUInt16LE(channels * 2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);
    return Buffer.concat([header, pcm]);
  }

  private serveWebClient(res: http.ServerResponse): void {
    const clientPath = path.resolve(
      process.cwd(),
      'clients/voice-web/index.html',
    );
    try {
      const html = fs.readFileSync(clientPath, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        '<html><body><h1>Voice Client</h1><p>Web client not found at clients/voice-web/index.html</p></body></html>',
      );
    }
  }
}
