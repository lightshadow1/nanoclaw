import type { Capability, CapabilityContext } from './types.js';
import { registerHooks, clearHooks } from './hooks.js';
import { runMigrations } from './lifecycle.js';
import { logger } from '../logger.js';

// --- Capability manifest ---
// Add new capabilities here. Order matters: capabilities are initialized
// in array order, torn down in reverse order.
import { debugLoggerCapability } from './debug-logger/index.js';

const CAPABILITIES: Capability[] = [debugLoggerCapability];

let activeCapabilities: Capability[] = [];

export async function loadCapabilities(ctx: CapabilityContext): Promise<void> {
  activeCapabilities = [];

  for (const cap of CAPABILITIES) {
    if (!cap.enabled()) {
      logger.info({ capability: cap.name }, 'Capability disabled, skipping');
      continue;
    }
    try {
      runMigrations(ctx.db, cap);
      await cap.init(ctx);
      if (cap.hooks) registerHooks(cap.name, cap.hooks);
      activeCapabilities.push(cap);
      logger.info({ capability: cap.name }, 'Capability loaded');
    } catch (err) {
      logger.error(
        { capability: cap.name, err },
        'Failed to load capability, skipping',
      );
    }
  }

  if (CAPABILITIES.length === 0) {
    logger.debug('No capabilities registered');
  }
}

export async function teardownCapabilities(): Promise<void> {
  for (const cap of [...activeCapabilities].reverse()) {
    try {
      await cap.teardown?.();
    } catch (err) {
      logger.error({ capability: cap.name, err }, 'Capability teardown error');
    }
  }
  activeCapabilities = [];
  clearHooks();
}

export function getActiveCapabilities(): readonly Capability[] {
  return activeCapabilities;
}
