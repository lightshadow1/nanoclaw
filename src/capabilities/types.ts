import type Database from 'better-sqlite3';

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

export interface CapabilityHooks {
  onMessageStored?(msg: StoredMessage): void;
  onMessageSent?(msg: SentMessage): void;
  onShutdown?(): Promise<void>;
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
}

export interface Capability {
  name: string;
  enabled(): boolean;
  migrations: MigrationBundle[];
  init(ctx: CapabilityContext): Promise<void>;
  teardown?(): Promise<void>;
  hooks?: CapabilityHooks;
}
