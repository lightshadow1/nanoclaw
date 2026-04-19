import type { CapabilityHooks, StoredMessage, SentMessage } from './types.js';
import { logger } from '../logger.js';

interface RegisteredHook {
  name: string;
  hooks: CapabilityHooks;
}

let registered: RegisteredHook[] = [];

export function registerHooks(name: string, hooks: CapabilityHooks): void {
  registered.push({ name, hooks });
}

export function dispatchMessageStored(msg: StoredMessage): void {
  for (const { name, hooks } of registered) {
    if (!hooks.onMessageStored) continue;
    try {
      hooks.onMessageStored(msg);
    } catch (err) {
      logger.error({ capability: name, err }, 'Hook error in onMessageStored');
    }
  }
}

export function dispatchMessageSent(msg: SentMessage): void {
  for (const { name, hooks } of registered) {
    if (!hooks.onMessageSent) continue;
    try {
      hooks.onMessageSent(msg);
    } catch (err) {
      logger.error({ capability: name, err }, 'Hook error in onMessageSent');
    }
  }
}

export async function dispatchShutdown(): Promise<void> {
  for (const { name, hooks } of registered) {
    if (!hooks.onShutdown) continue;
    try {
      await hooks.onShutdown();
    } catch (err) {
      logger.error({ capability: name, err }, 'Hook error in onShutdown');
    }
  }
}

export function clearHooks(): void {
  registered = [];
}
