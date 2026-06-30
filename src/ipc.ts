import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  DATA_DIR,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  TIMEZONE,
} from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { logger } from './logger.js';
import { MessageButton, RegisteredGroup, SendOptions } from './types.js';

export interface SpawnSoulRequest {
  folder: string;
  agentName: string;
  description?: string;
  spawnReason: string;
  topicKeywords?: string[];
}

export type SpawnSoulOutcome =
  | { ok: true; folder: string; did: string }
  | { ok: false; error: string };

export interface IpcDeps {
  sendMessage: (
    jid: string,
    text: string,
    opts?: SendOptions,
  ) => Promise<string | null>;
  // Create-or-edit a group's pinned ledger message. Optional: absent in
  // hosts/tests that don't wire channels.
  setLedger?: (chatJid: string, folder: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroupMetadata: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  // Optional: wired by the host only when the soul capability is enabled.
  // Absent → spawn_soul IPC requests are logged and dropped.
  spawnSoul?: (req: SpawnSoulRequest) => SpawnSoulOutcome;
  // Optional: publish a proposed bet to the owner's channel (Phase 6).
  publishBet?: (req: {
    betId: string;
  }) => Promise<{ ok: true; betId: string } | { ok: false; error: string }>;
  // Optional: send a file as a document to a chat. Absent in hosts/tests
  // that don't wire channels.
  sendDocument?: (
    chatJid: string,
    filename: string,
    content: string,
    caption?: string,
  ) => Promise<void>;
}

// Sanitize container-supplied inline buttons. Caps keep a compromised or
// confused agent from rendering walls of buttons; Telegram limits
// callback_data to 64 bytes.
const MAX_BUTTON_ROWS = 3;
const MAX_BUTTONS_PER_ROW = 3;
const MAX_BUTTON_ID_LEN = 64;
const MAX_BUTTON_LABEL_LEN = 48;

export function sanitizeButtons(raw: unknown): MessageButton[][] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const rows: MessageButton[][] = [];
  for (const rawRow of raw.slice(0, MAX_BUTTON_ROWS)) {
    if (!Array.isArray(rawRow)) continue;
    const row: MessageButton[] = [];
    for (const btn of rawRow.slice(0, MAX_BUTTONS_PER_ROW)) {
      if (
        typeof btn === 'object' &&
        btn !== null &&
        typeof (btn as { id?: unknown }).id === 'string' &&
        typeof (btn as { label?: unknown }).label === 'string' &&
        (btn as { id: string }).id.length > 0 &&
        (btn as { label: string }).label.length > 0
      ) {
        row.push({
          id: (btn as { id: string }).id.slice(0, MAX_BUTTON_ID_LEN),
          label: (btn as { label: string }).label.slice(
            0,
            MAX_BUTTON_LABEL_LEN,
          ),
        });
      }
    }
    if (row.length > 0) rows.push(row);
  }
  return rows.length > 0 ? rows : undefined;
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    for (const sourceGroup of groupFolders) {
      const isMain = sourceGroup === MAIN_GROUP_FOLDER;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.sendMessage(data.chatJid, data.text, {
                    buttons: sanitizeButtons(data.buttons),
                    silent: data.silent === true || undefined,
                  });
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    // For spawn_soul
    agentName?: string;
    description?: string;
    spawnReason?: string;
    topicKeywords?: string[];
    // For set_ledger
    text?: string;
    // For publish_bet
    betId?: string;
    // For send_document
    filename?: string;
    content?: string;
    caption?: string;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = scheduled.toISOString();
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroupMetadata(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'spawn_soul':
      // Spokesperson model: only the main soul may spawn dedicated souls.
      // Spawned souls are channel-less and speak through main, so a
      // non-main group spawning siblings would break the channel/budget
      // invariants.
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized spawn_soul attempt blocked');
        break;
      }
      if (!deps.spawnSoul) {
        logger.warn(
          { sourceGroup },
          'spawn_soul requested but soul capability is not enabled',
        );
        break;
      }
      if (!data.folder || !data.agentName || !data.spawnReason) {
        logger.warn(
          { data },
          'Invalid spawn_soul request - missing folder, agentName, or spawnReason',
        );
        break;
      }
      {
        const result = deps.spawnSoul({
          folder: data.folder,
          agentName: data.agentName,
          description: data.description,
          spawnReason: data.spawnReason,
          topicKeywords: data.topicKeywords,
        });
        if (result.ok) {
          logger.info(
            { folder: result.folder, did: result.did, sourceGroup },
            'Soul spawned via IPC',
          );
        } else {
          logger.warn(
            { folder: data.folder, error: result.error },
            'spawn_soul request failed',
          );
        }
      }
      break;

    case 'publish_bet':
      // Bets publish to the owner's main channel with budget consumption —
      // main-only, like spawn_soul.
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized publish_bet attempt blocked',
        );
        break;
      }
      if (!deps.publishBet) {
        logger.warn(
          { sourceGroup },
          'publish_bet requested but soul capability is not enabled',
        );
        break;
      }
      if (!data.betId) {
        logger.warn({ data }, 'Invalid publish_bet request - missing betId');
        break;
      }
      {
        const result = await deps.publishBet({ betId: data.betId });
        if (result.ok) {
          logger.info({ betId: result.betId, sourceGroup }, 'Bet published via IPC');
        } else {
          logger.warn(
            { betId: data.betId, error: result.error },
            'publish_bet request failed',
          );
        }
      }
      break;

    case 'set_ledger':
      // A group maintains its OWN chat's pinned ledger; main may set any.
      if (!deps.setLedger) {
        logger.warn(
          { sourceGroup },
          'set_ledger requested but host has no ledger support wired',
        );
        break;
      }
      if (!data.chatJid || typeof data.text !== 'string' || !data.text) {
        logger.warn({ data }, 'Invalid set_ledger request');
        break;
      }
      {
        const targetGroup = registeredGroups[data.chatJid];
        if (!isMain && (!targetGroup || targetGroup.folder !== sourceGroup)) {
          logger.warn(
            { chatJid: data.chatJid, sourceGroup },
            'Unauthorized set_ledger attempt blocked',
          );
          break;
        }
        const ledgerFolder = targetGroup?.folder ?? sourceGroup;
        await deps.setLedger(data.chatJid, ledgerFolder, data.text);
        logger.info(
          { chatJid: data.chatJid, sourceGroup },
          'Ledger updated via IPC',
        );
      }
      break;

    case 'send_document':
      // A group may send a document to its OWN chat; main may send anywhere.
      // Same posture as send_message.
      if (!deps.sendDocument) {
        logger.warn(
          { sourceGroup },
          'send_document requested but host has no channel wired',
        );
        break;
      }
      if (
        !data.chatJid ||
        typeof data.filename !== 'string' ||
        !data.filename ||
        typeof data.content !== 'string' ||
        !data.content
      ) {
        logger.warn({ data }, 'Invalid send_document request');
        break;
      }
      {
        const targetGroup = registeredGroups[data.chatJid];
        if (!isMain && (!targetGroup || targetGroup.folder !== sourceGroup)) {
          logger.warn(
            { chatJid: data.chatJid, sourceGroup },
            'Unauthorized send_document attempt blocked',
          );
          break;
        }
        const caption =
          typeof data.caption === 'string' ? data.caption.slice(0, 1024) : undefined;
        await deps.sendDocument(data.chatJid, data.filename, data.content, caption);
        logger.info(
          { chatJid: data.chatJid, filename: data.filename, sourceGroup },
          'Document sent via IPC',
        );
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
