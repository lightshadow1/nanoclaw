# Intent: src/config.ts modifications

## What changed
Added voice channel configuration exports that can be controlled via environment variables or `.env` file. These replace hardcoded values and allow runtime configuration.

## Additions

### envConfig readEnvFile() call (line 9-13)
Added four voice-related keys to read from `.env`:
- `VOICE_ENABLED` — whether to enable voice channel (string 'true'/'false')
- `VOICE_PORT` — WebSocket server port (numeric string)
- `VOICE_HOST` — WebSocket server hostname (string)
- `VOICE_GROUP` — name of the group that receives voice messages (string)

### New exports (lines 22-26)
```typescript
export const VOICE_ENABLED =
  (process.env.VOICE_ENABLED || envConfig.VOICE_ENABLED) === 'true';
export const VOICE_PORT = parseInt(process.env.VOICE_PORT || envConfig.VOICE_PORT || '8080', 10);
export const VOICE_HOST = process.env.VOICE_HOST || envConfig.VOICE_HOST || 'localhost';
export const VOICE_GROUP = process.env.VOICE_GROUP || envConfig.VOICE_GROUP || 'voice-main';
```

## Configuration logic

### VOICE_ENABLED (boolean)
- **Priority**: `process.env.VOICE_ENABLED` > `.env` VOICE_ENABLED > `false` (default)
- **Type**: boolean
- **Behavior**: Only `'true'` (exact string match) enables voice. Any other value defaults to false.
- **Usage**: In `src/index.ts` main() to conditionally create VoiceChannel

### VOICE_PORT (number)
- **Priority**: `process.env.VOICE_PORT` > `.env` VOICE_PORT > `'8080'` (default)
- **Type**: integer (parsed with parseInt)
- **Behavior**: Fails with NaN if non-numeric string provided (safe, will cause startup error)
- **Usage**: Passed to VoiceChannel constructor as `port` option

### VOICE_HOST (string)
- **Priority**: `process.env.VOICE_HOST` > `.env` VOICE_HOST > `'localhost'` (default)
- **Type**: string
- **Behavior**: No validation — any hostname string accepted (DNS resolution happens at WebSocket bind time)
- **Usage**: Passed to VoiceChannel constructor as `host` option

### VOICE_GROUP (string)
- **Priority**: `process.env.VOICE_GROUP` > `.env` VOICE_GROUP > `'voice-main'` (default)
- **Type**: string
- **Behavior**: No validation — any group name accepted
- **Usage**: In `src/index.ts` main() to register and determine which group receives voice messages

## Why this approach

1. **Follows existing pattern** — matches ASSISTANT_NAME and ASSISTANT_HAS_OWN_NUMBER pattern (env priority > .env > default)

2. **Secrets not exposed here** — VOICE_AUTH_TOKEN and SMALLEST_AI_API_KEY are read only in `voice.ts` where they're used, never stored in config.ts (see .env.example for how to set them)

3. **Runtime configuration** — allows different deployments to run on different ports/hosts without code changes

4. **Safe defaults** — port 8080, localhost, and voice-main are reasonable for local development and small deployments

5. **Optional feature** — VOICE_ENABLED=false means no VoiceChannel created, no extra WebSocket server, no voice JID routing. Users who don't need voice can ignore it.

## Used by

- `src/index.ts` main() — imports all four constants to decide if voice channel should start
- Voice channel's `.env.example` — documents these keys for users
- Test files — can override VOICE_ENABLED=false to skip voice tests without CLI args

## .env.example additions

These keys should be added to `.env.example`:

```bash
# Voice channel configuration (optional, set VOICE_ENABLED=true to enable)
VOICE_ENABLED=false
VOICE_PORT=8080
VOICE_HOST=localhost
VOICE_GROUP=voice-main
VOICE_AUTH_TOKEN={{your_voice_auth_token}}
SMALLEST_AI_API_KEY={{your_smallest_ai_api_key}}
```

Not added by this diff (added separately via intent.md).
