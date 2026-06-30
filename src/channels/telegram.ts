import { Bot, InlineKeyboard, InputFile } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChannelEvent,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
  SendOptions,
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  // Optional: button taps and reactions. Only registered chats emit events.
  onChannelEvent?: OnChannelEvent;
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken);

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    this.bot.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      this.opts.onChatMetadata(chatJid, timestamp, chatName);

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      this.opts.onChatMetadata(chatJid, timestamp);
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', (ctx) => storeNonText(ctx, '[Photo]'));
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', (ctx) =>
      storeNonText(ctx, '[Voice message]'),
    );
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeNonText(ctx, `[Document: ${name}]`);
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Button taps. Telegram requires answering every callback query (the
    // client shows a spinner until we do), then we surface the tap as a
    // ChannelEvent so the host can both record it and react to it.
    this.bot.on('callback_query:data', async (ctx) => {
      try {
        await ctx.answerCallbackQuery();
      } catch (err) {
        logger.debug({ err }, 'Failed to answer Telegram callback query');
      }

      const msg = ctx.callbackQuery.message;
      if (!msg) return;
      const chatJid = `tg:${msg.chat.id}`;
      if (!this.opts.registeredGroups()[chatJid]) return;

      // Resolve the human-readable label from the keyboard we sent.
      const data = ctx.callbackQuery.data;
      let label: string | undefined;
      const keyboard = msg.reply_markup?.inline_keyboard ?? [];
      for (const row of keyboard) {
        for (const btn of row) {
          if ('callback_data' in btn && btn.callback_data === data) {
            label = btn.text;
          }
        }
      }

      const sourceText =
        'text' in msg && msg.text ? msg.text.slice(0, 80) : undefined;

      this.opts.onChannelEvent?.({
        kind: 'button',
        chatJid,
        messageId: msg.message_id.toString(),
        sender: ctx.from.id.toString(),
        senderName: ctx.from.first_name || ctx.from.username || 'Unknown',
        data,
        label,
        sourceText,
        timestamp: new Date().toISOString(),
      });
    });

    // Reactions. Not in Telegram's default update set — see allowed_updates
    // in start() below. Only newly-added emoji are reported (removals are
    // visible in old_reaction but not interesting to us).
    this.bot.on('message_reaction', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      if (!this.opts.registeredGroups()[chatJid]) return;

      const update = ctx.messageReaction;
      const oldEmoji = new Set(
        update.old_reaction
          .filter((r) => r.type === 'emoji')
          .map((r) => (r as { emoji: string }).emoji),
      );
      const added = update.new_reaction
        .filter((r) => r.type === 'emoji')
        .map((r) => (r as { emoji: string }).emoji)
        .filter((e) => !oldEmoji.has(e));
      if (added.length === 0) return;

      this.opts.onChannelEvent?.({
        kind: 'reaction',
        chatJid,
        messageId: update.message_id.toString(),
        sender: update.user?.id.toString() || '',
        senderName:
          update.user?.first_name || update.user?.username || 'Unknown',
        emoji: added[added.length - 1],
        timestamp: new Date(update.date * 1000).toISOString(),
      });
    });

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started.
    // allowed_updates must be explicit: message_reaction is excluded from
    // Telegram's default set, and once you pass the list you must include
    // everything you want (it replaces, not extends, the default).
    return new Promise<void>((resolve) => {
      this.bot!.start({
        allowed_updates: [
          'message',
          'edited_message',
          'callback_query',
          'message_reaction',
        ],
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(
    jid: string,
    text: string,
    opts?: SendOptions,
  ): Promise<string | null> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return null;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');

      let keyboard: InlineKeyboard | undefined;
      if (opts?.buttons && opts.buttons.length > 0) {
        const kb = new InlineKeyboard();
        opts.buttons.forEach((row, idx) => {
          if (idx > 0) kb.row();
          for (const btn of row) {
            // callback_data is capped at 64 bytes by Telegram.
            kb.text(btn.label, btn.id.slice(0, 64));
          }
        });
        keyboard = kb;
      }

      // Telegram has a 4096 character limit per message — split if needed.
      // Buttons attach to the LAST chunk so they sit under the full text.
      const MAX_LENGTH = 4096;
      const chunks: string[] = [];
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        chunks.push(text.slice(i, i + MAX_LENGTH));
      }

      let lastMessageId: string | null = null;
      for (let i = 0; i < chunks.length; i++) {
        const isLast = i === chunks.length - 1;
        const sent = await this.bot.api.sendMessage(numericId, chunks[i], {
          disable_notification: opts?.silent || undefined,
          reply_markup: isLast ? keyboard : undefined,
        });
        lastMessageId = sent.message_id.toString();
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
      return lastMessageId;
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
      return null;
    }
  }

  async editMessage(
    jid: string,
    messageId: string,
    text: string,
  ): Promise<void> {
    if (!this.bot) throw new Error('Telegram bot not initialized');
    const numericId = jid.replace(/^tg:/, '');
    await this.bot.api.editMessageText(
      numericId,
      parseInt(messageId, 10),
      text.slice(0, 4096),
    );
  }

  async pinMessage(jid: string, messageId: string): Promise<void> {
    if (!this.bot) throw new Error('Telegram bot not initialized');
    const numericId = jid.replace(/^tg:/, '');
    await this.bot.api.pinChatMessage(numericId, parseInt(messageId, 10), {
      disable_notification: true,
    });
  }

  async sendDocument(
    jid: string,
    filename: string,
    content: string,
    caption?: string,
  ): Promise<void> {
    if (!this.bot) throw new Error('Telegram bot not initialized');
    const numericId = jid.replace(/^tg:/, '');
    const file = new InputFile(Buffer.from(content, 'utf8'), filename);
    await this.bot.api.sendDocument(numericId, file, { caption });
    logger.info({ jid, filename, length: content.length }, 'Telegram document sent');
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}
