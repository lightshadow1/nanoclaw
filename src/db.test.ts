import { describe, it, expect, beforeEach } from 'vitest';

import { ASSISTANT_NAME } from './config.js';
import {
  _initTestDatabase,
  claimDueTasks,
  createTask,
  deleteTask,
  finalizeClaimedTask,
  getAllChats,
  getMessagesSince,
  getNewMessages,
  getDb,
  getTaskById,
  releaseInterruptedTaskClaims,
  searchMessageHistory,
  storeChatMetadata,
  storeMessage,
  updateTask,
} from './db.js';

beforeEach(() => {
  _initTestDatabase();
});

// Helper to store a message using the normalized NewMessage interface
function store(overrides: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
}) {
  storeMessage({
    id: overrides.id,
    chat_jid: overrides.chat_jid,
    sender: overrides.sender,
    sender_name: overrides.sender_name,
    content: overrides.content,
    timestamp: overrides.timestamp,
    is_from_me: overrides.is_from_me ?? false,
  });
}

// --- storeMessage (NewMessage format) ---

describe('storeMessage', () => {
  it('stores a message and retrieves it', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'hello world',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      ASSISTANT_NAME,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('msg-1');
    expect(messages[0].sender).toBe('123@s.whatsapp.net');
    expect(messages[0].sender_name).toBe('Alice');
    expect(messages[0].content).toBe('hello world');
  });

  it('stores empty content', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-2',
      chat_jid: 'group@g.us',
      sender: '111@s.whatsapp.net',
      sender_name: 'Dave',
      content: '',
      timestamp: '2024-01-01T00:00:04.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      ASSISTANT_NAME,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('');
  });

  it('stores is_from_me flag', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-3',
      chat_jid: 'group@g.us',
      sender: 'me@s.whatsapp.net',
      sender_name: 'Me',
      content: 'my message',
      timestamp: '2024-01-01T00:00:05.000Z',
      is_from_me: true,
    });

    // Message is stored (we can retrieve it — is_from_me doesn't affect retrieval)
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      ASSISTANT_NAME,
    );
    expect(messages).toHaveLength(1);
  });

  it('upserts on duplicate id+chat_jid', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'original',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'updated',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      ASSISTANT_NAME,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('updated');
  });
});

describe('searchMessageHistory', () => {
  beforeEach(() => {
    storeChatMetadata('group-1', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group-2', '2024-01-01T00:00:00.000Z');
    store({
      id: 'search-1',
      chat_jid: 'group-1',
      sender: 'alice',
      sender_name: 'Alice',
      content: 'We approved the blue deployment plan',
      timestamp: '2024-01-01T10:00:00.000Z',
    });
    store({
      id: 'search-2',
      chat_jid: 'group-2',
      sender: 'bob',
      sender_name: 'Bob',
      content: 'The deployment was postponed',
      timestamp: '2024-01-02T10:00:00.000Z',
    });
    storeMessage({
      id: 'search-bot',
      chat_jid: 'group-1',
      sender: 'bot',
      sender_name: 'Andy',
      content: 'deployment automation complete',
      timestamp: '2024-01-03T10:00:00.000Z',
      is_bot_message: true,
    });
  });

  it('searches exact phrases within authorized chat JIDs', () => {
    const results = searchMessageHistory({
      query: '"blue deployment"',
      chatJids: ['group-1'],
    });
    expect(results.map((result) => result.id)).toEqual(['search-1']);
  });

  it('supports trailing prefix queries and time bounds', () => {
    const results = searchMessageHistory({
      query: 'deploy*',
      chatJids: ['group-1', 'group-2'],
      after: '2024-01-01T12:00:00.000Z',
    });
    expect(results.map((result) => result.id)).toEqual(['search-2']);
  });

  it('excludes bot messages by default and includes them on request', () => {
    expect(
      searchMessageHistory({ query: 'automation', chatJids: ['group-1'] }),
    ).toHaveLength(0);
    expect(
      searchMessageHistory({
        query: 'automation',
        chatJids: ['group-1'],
        includeBotMessages: true,
      }).map((result) => result.id),
    ).toEqual(['search-bot']);
  });

  it('keeps the index coherent across update and delete', () => {
    store({
      id: 'search-1',
      chat_jid: 'group-1',
      sender: 'alice',
      sender_name: 'Alice',
      content: 'The green release replaced it',
      timestamp: '2024-01-01T10:00:00.000Z',
    });
    expect(
      searchMessageHistory({ query: 'blue', chatJids: ['group-1'] }),
    ).toHaveLength(0);
    expect(
      searchMessageHistory({ query: 'green', chatJids: ['group-1'] }),
    ).toHaveLength(1);

    getDb()
      .prepare('DELETE FROM messages WHERE id = ? AND chat_jid = ?')
      .run('search-1', 'group-1');
    expect(
      searchMessageHistory({ query: 'green', chatJids: ['group-1'] }),
    ).toHaveLength(0);
  });

  it('rejects empty, oversized, and invalid time queries', () => {
    expect(() =>
      searchMessageHistory({ query: ' ', chatJids: ['group-1'] }),
    ).toThrow('cannot be empty');
    expect(() =>
      searchMessageHistory({ query: 'x'.repeat(257), chatJids: ['group-1'] }),
    ).toThrow('exceeds 256');
    expect(() =>
      searchMessageHistory({
        query: 'deployment',
        chatJids: ['group-1'],
        before: 'not-a-date',
      }),
    ).toThrow('Invalid history search before');
  });
});

// --- getMessagesSince ---

describe('getMessagesSince', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'm1',
      chat_jid: 'group@g.us',
      sender: 'Alice@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'first',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'm2',
      chat_jid: 'group@g.us',
      sender: 'Bob@s.whatsapp.net',
      sender_name: 'Bob',
      content: 'second',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'm3',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'm4',
      chat_jid: 'group@g.us',
      sender: 'Carol@s.whatsapp.net',
      sender_name: 'Carol',
      content: 'third',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns messages after the given timestamp', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:02.000Z',
      ASSISTANT_NAME,
    );
    // Should exclude m1, m2 (before/at timestamp), m3 (bot message)
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('third');
  });

  it('excludes bot messages via is_bot_message flag', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      ASSISTANT_NAME,
    );
    const botMsgs = msgs.filter((m) => m.content === 'bot reply');
    expect(botMsgs).toHaveLength(0);
  });

  it('returns all non-bot messages when sinceTimestamp is empty', () => {
    const msgs = getMessagesSince('group@g.us', '', ASSISTANT_NAME);
    // 3 user messages (bot message excluded)
    expect(msgs).toHaveLength(3);
  });

  it('filters pre-migration bot messages via content prefix backstop', () => {
    // Simulate a message written before migration: has prefix but is_bot_message = 0
    store({
      id: 'm5',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: `${ASSISTANT_NAME}: old bot reply`,
      timestamp: '2024-01-01T00:00:05.000Z',
    });
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:04.000Z',
      ASSISTANT_NAME,
    );
    expect(msgs).toHaveLength(0);
  });
});

// --- getNewMessages ---

describe('getNewMessages', () => {
  beforeEach(() => {
    storeChatMetadata('group1@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group2@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'a1',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg1',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'a2',
      chat_jid: 'group2@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g2 msg1',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'a3',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'a4',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg2',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns new messages across multiple groups', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:00.000Z',
      ASSISTANT_NAME,
    );
    // Excludes bot message, returns 3 user messages
    expect(messages).toHaveLength(3);
    expect(newTimestamp).toBe('2024-01-01T00:00:04.000Z');
  });

  it('filters by timestamp', () => {
    const { messages } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:02.000Z',
      ASSISTANT_NAME,
    );
    // Only g1 msg2 (after ts, not bot)
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('g1 msg2');
  });

  it('returns empty for no registered groups', () => {
    const { messages, newTimestamp } = getNewMessages([], '', ASSISTANT_NAME);
    expect(messages).toHaveLength(0);
    expect(newTimestamp).toBe('');
  });
});

// --- storeChatMetadata ---

describe('storeChatMetadata', () => {
  it('stores chat with JID as default name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].jid).toBe('group@g.us');
    expect(chats[0].name).toBe('group@g.us');
  });

  it('stores chat with explicit name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z', 'My Group');
    const chats = getAllChats();
    expect(chats[0].name).toBe('My Group');
  });

  it('updates name on subsequent call with name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z', 'Updated Name');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].name).toBe('Updated Name');
  });

  it('preserves newer timestamp on conflict', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:05.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z');
    const chats = getAllChats();
    expect(chats[0].last_message_time).toBe('2024-01-01T00:00:05.000Z');
  });
});

// --- Task CRUD ---

describe('task CRUD', () => {
  it('creates and retrieves a task', () => {
    createTask({
      id: 'task-1',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'do something',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-1');
    expect(task).toBeDefined();
    expect(task!.prompt).toBe('do something');
    expect(task!.status).toBe('active');
  });

  it('updates task status', () => {
    createTask({
      id: 'task-2',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    updateTask('task-2', { status: 'paused' });
    expect(getTaskById('task-2')!.status).toBe('paused');
  });

  it('deletes a task and its run logs', () => {
    createTask({
      id: 'task-3',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'delete me',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    deleteTask('task-3');
    expect(getTaskById('task-3')).toBeUndefined();
  });
});

describe('scheduled task claims', () => {
  function createDueTask(
    id: string,
    overrides: Partial<Parameters<typeof createTask>[0]> = {},
  ) {
    createTask({
      id,
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'run me',
      schedule_type: 'cron',
      schedule_value: '0 * * * *',
      context_mode: 'isolated',
      next_run: '2026-01-01T00:00:00.000Z',
      status: 'active',
      created_at: '2025-01-01T00:00:00.000Z',
      ...overrides,
    });
  }

  it('atomically claims a due occurrence only once', () => {
    createDueTask('claim-once');
    const now = new Date('2026-01-01T00:01:00.000Z');

    const first = claimDueTasks(now);
    const second = claimDueTasks(now);

    expect(first).toHaveLength(1);
    expect(first[0].claim_token).toBeTruthy();
    expect(first[0].claimed_at).toBe(now.toISOString());
    expect(second).toEqual([]);
  });

  it('does not claim future, paused, completed, or already claimed tasks', () => {
    createDueTask('future', { next_run: '2027-01-01T00:00:00.000Z' });
    createDueTask('paused', { status: 'paused' });
    createDueTask('completed', { status: 'completed' });
    createDueTask('claimed');
    claimDueTasks(new Date('2026-01-01T00:01:00.000Z'), 1);

    expect(claimDueTasks(new Date('2026-01-01T00:01:00.000Z'))).toEqual([]);
  });

  it('respects due ordering and claim limit with distinct tokens', () => {
    createDueTask('later', { next_run: '2026-01-01T00:00:02.000Z' });
    createDueTask('earlier', { next_run: '2026-01-01T00:00:01.000Z' });

    const first = claimDueTasks(new Date('2026-01-01T00:01:00.000Z'), 1);
    const second = claimDueTasks(new Date('2026-01-01T00:01:00.000Z'), 1);

    expect(first.map((task) => task.id)).toEqual(['earlier']);
    expect(second.map((task) => task.id)).toEqual(['later']);
    expect(first[0].claim_token).not.toBe(second[0].claim_token);
  });

  it('finalizes only the matching claim and clears ownership', () => {
    createDueTask('finalize');
    const [task] = claimDueTasks(new Date('2026-01-01T00:01:00.000Z'));

    expect(
      finalizeClaimedTask(
        task.id,
        'wrong-token',
        '2026-01-01T01:00:00.000Z',
        'wrong',
      ),
    ).toBe(false);
    expect(getTaskById(task.id)!.claim_token).toBe(task.claim_token);

    expect(
      finalizeClaimedTask(
        task.id,
        task.claim_token,
        '2026-01-01T01:00:00.000Z',
        'done',
      ),
    ).toBe(true);
    const finalized = getTaskById(task.id)!;
    expect(finalized.next_run).toBe('2026-01-01T01:00:00.000Z');
    expect(finalized.last_result).toBe('done');
    expect(finalized.claim_token).toBeNull();
    expect(finalized.claimed_at).toBeNull();
  });

  it('completes a one-shot task when its claim is finalized', () => {
    createDueTask('once', {
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
    });
    const [task] = claimDueTasks(new Date('2026-01-01T00:01:00.000Z'));

    expect(finalizeClaimedTask(task.id, task.claim_token, null, 'done')).toBe(
      true,
    );
    expect(getTaskById(task.id)).toMatchObject({
      status: 'completed',
      next_run: null,
      claim_token: null,
    });
  });

  it('preserves an explicit pause applied while a one-shot task is claimed', () => {
    createDueTask('paused-during-run', {
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
    });
    const [task] = claimDueTasks(new Date('2026-01-01T00:01:00.000Z'));
    updateTask(task.id, { status: 'paused' });

    expect(finalizeClaimedTask(task.id, task.claim_token, null, 'done')).toBe(
      true,
    );
    expect(getTaskById(task.id)).toMatchObject({
      status: 'paused',
      next_run: null,
      claim_token: null,
    });
  });

  it('releases interrupted claims without changing the occurrence', () => {
    createDueTask('interrupted');
    const [task] = claimDueTasks(new Date('2026-01-01T00:01:00.000Z'));

    expect(releaseInterruptedTaskClaims()).toEqual(['interrupted']);
    expect(getTaskById(task.id)).toMatchObject({
      status: 'active',
      next_run: '2026-01-01T00:00:00.000Z',
      claim_token: null,
      claimed_at: null,
    });
    expect(releaseInterruptedTaskClaims()).toEqual([]);
  });
});
