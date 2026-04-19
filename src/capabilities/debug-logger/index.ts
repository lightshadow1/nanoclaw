import type { Capability } from '../types.js';
import { logger } from '../../logger.js';

export const debugLoggerCapability: Capability = {
  name: 'debug-logger',

  enabled: () => true,

  migrations: [],

  init: async () => {
    logger.info('🔌 debug-logger capability initialized');
  },

  teardown: async () => {
    logger.info('🔌 debug-logger capability torn down');
  },

  hooks: {
    onMessageStored: (msg) => {
      logger.info(
        {
          id: msg.id,
          sender: msg.senderName,
          group: msg.groupFolder,
          content: msg.content.slice(0, 80),
        },
        '🪝 onMessageStored hook fired',
      );
    },

    onMessageSent: (msg) => {
      logger.info(
        {
          group: msg.groupFolder,
          content: msg.content.slice(0, 80),
        },
        '🪝 onMessageSent hook fired',
      );
    },

    onShutdown: async () => {
      logger.info('🪝 onShutdown hook fired');
    },
  },
};
