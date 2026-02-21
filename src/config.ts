import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets are NOT read here — they stay on disk and are loaded only
// where needed (container-runner.ts) to avoid leaking to child processes.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Jarvis';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER || envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || '/Users/user';

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const MAIN_GROUP_FOLDER = 'main';

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(
  process.env.IDLE_TIMEOUT || '1800000',
  10,
); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// Voice channel
const voiceEnv = readEnvFile([
  'VOICE_ENABLED', 'VOICE_PORT', 'VOICE_HOST', 'VOICE_GROUP',
  'VOICE_TLS_CERT', 'VOICE_TLS_KEY',
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
export const VOICE_TLS_CERT =
  process.env.VOICE_TLS_CERT || voiceEnv.VOICE_TLS_CERT || '';
export const VOICE_TLS_KEY =
  process.env.VOICE_TLS_KEY || voiceEnv.VOICE_TLS_KEY || '';
// VOICE_AUTH_TOKEN and SMALLEST_AI_API_KEY are read at runtime by VoiceChannel
// (not exported here — kept out of process environment)
