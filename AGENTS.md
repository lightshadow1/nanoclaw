# Agent Rules for NanoClaw Development

## Architecture Overview

### Multi-Channel Design

NanoClaw supports multiple communication channels through a unified `Channel` interface:

**Active Channels:**
- `WhatsAppChannel` - Primary messaging via WhatsApp (baileys)
- `VoiceChannel` - Real-time voice interface via WebSocket (Smallest.ai STT/TTS)

**Channel Interface:**
```typescript
interface Channel {
  name: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
}
```

**JID Format:**
- WhatsApp groups: `120363336345536173@g.us`
- WhatsApp DMs: `1234567890@s.whatsapp.net`
- Voice interface: `voice:main@local` (maps to a group context)

**Channel Routing:**
Messages are routed via `findChannel(jid)` which checks `channel.ownsJid(jid)` for each registered channel.

### Voice Channel Architecture

**Components:**
1. **VoiceChannel** (`src/channels/voice.ts`) - WebSocket server with STT/TTS integration
2. **Web Client** (`clients/voice-web/index.html`) - Browser-based UI with VAD
3. **Smallest.ai API** - External STT (Pulse) and TTS (Lightning) services

**Voice Flow:**
```
Browser Mic → VAD → WebSocket → VoiceChannel
                                      ↓
                              Smallest.ai STT
                                      ↓
                              Orchestrator → GroupQueue → Container
                                      ↓
                              LLM Response (text)
                                      ↓
                              sanitizeForTTS() → enhanceProsody()
                                      ↓
                              Smallest.ai TTS
                                      ↓
                              WebSocket → Browser Speaker
```

**Key Design Decisions:**
- No SSML support (Smallest.ai limitation) - use punctuation for prosody
- Container pre-warming on first connection (eliminates 3-5s cold start)
- Text chunking (250 char limit for Lightning model)
- Retry logic for transient network errors (DNS, ECONNRESET)

## Skill Documentation

When working on a `.claude/skills/*` directory or modifying skill implementations, always check if the corresponding `SKILL.md` file needs to be updated with:

- New features added
- Bugs fixed and their solutions
- API endpoint changes
- Production optimizations and learnings
- Configuration updates
- Troubleshooting steps
- Implementation examples

**Example:** After implementing and debugging a feature, document all production issues encountered and their fixes in a "Production Fixes & Optimizations" section, so future developers benefit from the learnings.
