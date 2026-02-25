# Add Voice Channel

This skill adds real-time voice interaction to NanoClaw. Audio streams bidirectionally over WebSocket — the user's voice is transcribed server-side via Smallest.ai Pulse API, routed through NanoClaw's existing orchestrator, and the agent's text response is synthesized back to speech via Smallest.ai Lightning API and streamed to a web client.

The voice channel is a peer to WhatsApp/Telegram, not a replacement. Both run simultaneously. A voice session maps to a configured group context (shared CLAUDE.md, shared session).

## Quick Start

### Installation

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-voice
```

The skill engine will:
1. Copy voice channel source code and tests
2. Add multi-channel routing to main application
3. Install npm dependencies (ws, @types/ws)
4. Add environment variables to .env.example
5. Run tests to verify integration

### Configuration

After installation, configure in `.env`:

```bash
# Enable voice channel
VOICE_ENABLED=true

# WebSocket server configuration
VOICE_PORT=8443
VOICE_HOST=127.0.0.1

# Which group receives voice messages (usually 'main')
VOICE_GROUP=main

# Security: pre-shared token for WebSocket authentication
VOICE_AUTH_TOKEN=$(openssl rand -hex 32)

# Smallest.ai API credentials
# Get from https://www.smallest.ai/
SMALLEST_AI_API_KEY=your_api_key_here
```

### Access the Voice Client

After starting NanoClaw:

```bash
open http://localhost:8443
```

Or for remote access via Tailscale:

```bash
open http://<tailscale-ip>:8443
```

Enter the `VOICE_AUTH_TOKEN` from your .env and click Connect.

## Architecture

```
┌──────────────────────────┐      Encrypted WSS        ┌─────────────────────┐
│  Web Client (Browser)    │◄──────────────────────────►│  NanoClaw Host      │
│  (Phone/Laptop)          │     Tailscale/WireGuard    │                     │
│                          │                            │  ┌─────────────────┐│
│  mic → VAD ──────────────┼─── audio (pcm) ──────────►│  │  VoiceChannel   ││
│  speaker ◄──────────────┼─── audio (pcm) ◄──────────│  │  (WebSocket)    ││
│                          │                            │  │                 ││
│                          │                            │  │ Smallest.ai API ││
│                          │                            │  │ - Transcribe    ││
│                          │                            │  │ - Synthesize    ││
│                          │                            │  └────────┬────────┘│
│                          │                            │           │        │
│                          │                            │           ▼        │
│                          │                            │  ┌─────────────────┐│
│                          │                            │  │  Orchestrator   ││
│                          │                            │  │  GroupQueue/IPC ││
│                          │                            │  └─────────────────┘│
└──────────────────────────┘                            └─────────────────────┘
```

## Prerequisites

1. **Smallest.ai Account** — Get API key from https://www.smallest.ai/
2. **Node.js** — Already installed with NanoClaw
3. **WebSocket Support** — Modern browser with Web Audio API
4. **Network** — Access to Smallest.ai API (for transcription/synthesis)

## Features

### Real-time Voice Interaction

- **Bidirectional audio** over secure WebSocket
- **Voice Activity Detection** (VAD) — automatically starts recording on speech
- **Low latency** — Smallest.ai API optimized for fast transcription/synthesis
- **Multi-device** — Access from phone, laptop, or any modern browser
- **Secure** — Pre-shared token authentication, no credentials in code

### Integration with NanoClaw

- **Same agent context** — Voice messages use the same group memory and sessions as WhatsApp/Telegram
- **Concurrent channels** — Run voice alongside WhatsApp, Telegram, etc.
- **Container pre-warming** — Automatically spins up agent containers on first voice connection
- **Configurable group** — Route voice to any registered group (main, projects, etc.)

## Troubleshooting

### WebSocket won't connect

- Verify `VOICE_ENABLED=true` in `.env`
- Check port is accessible: `lsof -i :8443`
- Verify `VOICE_AUTH_TOKEN` matches between `.env` and browser
- Check logs: `tail -f logs/nanoclaw.log | grep -i voice`

### Transcription is empty or incorrect

- Verify `SMALLEST_AI_API_KEY` is set correctly
- Test Smallest.ai API: `curl https://api.smallest.ai/api/health`
- Check microphone permissions in browser (Security → Microphone)
- Ensure VAD is capturing speech (visual feedback in UI)

### TTS is slow or not working

- First request may be slow (API cold start)
- Verify `SMALLEST_AI_API_KEY` has TTS quota
- Check Smallest.ai API status

### Port already in use

```bash
# Find process using the port
lsof -i :8443

# Kill it or use a different port in .env
VOICE_PORT=8444
```

## Advanced Configuration

### Remote Access via Tailscale

By default, voice is bound to localhost (`127.0.0.1:8443`). For remote access:

1. Ensure Tailscale is running on your NanoClaw host
2. Keep `VOICE_HOST=127.0.0.1` (localhost-only is secure)
3. Get your Tailscale IP: `tailscale ip -4` (e.g., `100.64.1.5`)
4. Access from remote machine: `http://100.64.1.5:8443`

Tailscale provides encrypted tunneling automatically.

### Custom Audio Format

The voice channel uses:
- **Capture**: PCM 16-bit, 16kHz, mono (from browser Web Audio API)
- **Playback**: PCM 16-bit, 24kHz, mono (from Smallest.ai)

These are optimized for low-latency voice synthesis. Don't change unless you're customizing the web client.

### Multiple Groups

If you have multiple registered groups, you can route voice to any of them:

```bash
# Voice goes to 'projects' group instead of 'main'
VOICE_GROUP=projects
```

Each group gets its own container session and conversation memory.

## Security Considerations

- **Token-based auth**: Pre-shared token in `.env` prevents unauthorized connections
- **Localhost binding**: Only accessible via Tailscale/VPN by default
- **No secrets in logs**: Auth tokens and API keys are never logged
- **Audio not persisted**: Voice audio is transcribed and discarded (transcribed text is stored like WhatsApp messages)
- **Secure tunnel**: Tailscale/WireGuard encrypts all traffic end-to-end

## Performance Notes

- **First request**: 1-2 seconds (Smallest.ai API cold start)
- **Subsequent requests**: <100ms latency typical
- **Concurrent users**: Limited only by container capacity (default 5 concurrent agents)
- **Long responses**: Automatically chunked and streamed to prevent timeouts

## What This Skill Does NOT Do

- ❌ Wake word detection (user explicitly speaks after clicking)
- ❌ Local speech processing (uses Smallest.ai cloud API)
- ❌ Multi-language mixing (use single language per session)
- ❌ Voice-to-voice synthesis (uses STT → LLM → TTS pipeline)
- ❌ Mobile app (web client works on mobile browsers)

## Related Skills

- **add-voice-transcription** — Transcribe WhatsApp voice notes using Whisper API
- **add-telegram** — Add Telegram bot support
- **add-gmail** — Add Gmail integration
- **customize** — Add other channels or modify NanoClaw behavior

## Support

For issues or questions:
1. Check the troubleshooting section above
2. Review logs: `tail -f logs/nanoclaw.log`
3. Test Smallest.ai API: `curl https://api.smallest.ai/api/health`
4. Check NanoClaw documentation: https://github.com/qwibitai/nanoclaw
