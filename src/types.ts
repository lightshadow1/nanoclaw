export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/nanoclaw/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
}

export interface HistorySearchOptions {
  query: string;
  chatJids: string[];
  limit?: number;
  before?: string;
  after?: string;
  includeBotMessages?: boolean;
}

export interface HistorySearchResult {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message: boolean;
  rank: number;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  capability_profile: import('./task-capability-profiles.js').TaskCapabilityProfileName;
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
  claim_token?: string | null;
  claimed_at?: string | null;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
  execution_context?: string | null;
}

// --- Channel abstraction ---

// One row of inline buttons. `id` becomes the callback payload delivered back
// as a ChannelEvent when the user taps it (Telegram callback_data, max 64
// bytes). Channels without button support ignore these.
export interface MessageButton {
  id: string;
  label: string;
}

export interface SendOptions {
  buttons?: MessageButton[][];
  // Deliver without a notification sound (Telegram disable_notification).
  // For ambient/low-priority content that shouldn't buzz the owner's phone.
  silent?: boolean;
}

// Interaction events that aren't messages: button taps and reactions.
// `messageId` is the channel-native id of the message interacted with.
export interface ChannelButtonEvent {
  kind: 'button';
  chatJid: string;
  messageId: string;
  sender: string;
  senderName: string;
  data: string; // the tapped button's id
  label?: string; // the tapped button's label, when resolvable
  sourceText?: string; // excerpt of the message the button was attached to
  timestamp: string;
}

export interface ChannelReactionEvent {
  kind: 'reaction';
  chatJid: string;
  messageId: string;
  sender: string;
  senderName: string;
  emoji: string;
  timestamp: string;
}

export type ChannelEvent = ChannelButtonEvent | ChannelReactionEvent;

export type OnChannelEvent = (event: ChannelEvent) => void;

export interface Channel {
  name: string;
  connect(): Promise<void>;
  // Returns the channel-native message id when the channel exposes one
  // (Telegram), null otherwise. Callers that don't track ids ignore it.
  sendMessage(
    jid: string,
    text: string,
    opts?: SendOptions,
  ): Promise<string | null>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  // Optional: edit a previously sent message in place.
  editMessage?(jid: string, messageId: string, text: string): Promise<void>;
  // Optional: pin a message in the chat.
  pinMessage?(jid: string, messageId: string): Promise<void>;
  // Optional: send a file (e.g. a markdown draft) as a document attachment.
  // content is the file body; filename is the displayed name.
  sendDocument?(
    jid: string,
    filename: string,
    content: string,
    caption?: string,
  ): Promise<void>;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (WhatsApp syncGroupMetadata) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;
