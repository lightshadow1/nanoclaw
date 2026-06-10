import type Database from 'better-sqlite3';
import type { ChannelEvent, SendOptions } from '../types.js';

export interface StoredMessage {
  id: string;
  chatJid: string;
  sender: string;
  senderName: string;
  content: string;
  timestamp: string;
  isFromMe: boolean;
  isBotMessage: boolean;
  groupFolder: string | null;
  source: string | null;
}

export interface SentMessage {
  chatJid: string;
  content: string;
  timestamp: string;
  groupFolder: string;
}

export interface ScheduledTaskInfo {
  id: string;
  group_folder: string;
  schedule_type: 'cron' | 'interval' | 'once';
}

export interface CapabilityHooks {
  onMessageStored?(msg: StoredMessage): void;
  onMessageSent?(msg: SentMessage): void;
  onShutdown?(): Promise<void>;
  // Return false to skip this task run. Lets a capability gate an
  // expensive scheduled task (e.g. don't fire the soul curator if no
  // new memories accumulated). Skipped runs still advance next_run.
  beforeTaskRun?(task: ScheduledTaskInfo): boolean | Promise<boolean>;
  // Interaction events that aren't messages: button taps and reactions.
  onChannelEvent?(event: ChannelEvent): void;
}

export interface MigrationBundle {
  version: string;
  up(db: Database.Database): void;
  down(db: Database.Database): void;
}

export interface CapabilityContext {
  db: Database.Database;
  registeredGroups: () => Record<string, { name: string; folder: string }>;
  projectRoot: string;
  groupsDir: string;
  dataDir: string;
  // Outbound primitives, wired by the host as lazy closures (capabilities
  // load before channels connect; the closures resolve a channel at call
  // time). Absent in test harnesses that don't exercise outbound paths.
  sendMessage?: (
    jid: string,
    text: string,
    opts?: SendOptions,
  ) => Promise<string | null>;
  // Create-or-edit the group's pinned ledger message (see src/ledger.ts).
  setLedger?: (chatJid: string, folder: string, text: string) => Promise<void>;
}

export interface Capability {
  name: string;
  enabled(): boolean;
  migrations: MigrationBundle[];
  init(ctx: CapabilityContext): Promise<void>;
  teardown?(): Promise<void>;
  hooks?: CapabilityHooks;
}
