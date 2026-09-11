// Fork-specific launcher: fixed read-only commands and loopback-only networking.
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createApp } from './server.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function forkConfig(projectRoot = root) {
  return {
    privateOnly: true,
    refreshSeconds: 60,
    clis: {
      nanoclaw: {
        bin: process.execPath,
        cwd: projectRoot,
        resources: ['tasks', 'runs', 'souls', 'bets', 'containers'].map((name) => ({ name, description: 'Up to 500 rows; newest runs and bets first' })),
        list: [resolve(projectRoot, 'dist/dashboard-cli.js'), '{resource}'],
        output: 'json',
        badges: {
          status: { active: 'green', paused: 'gray', success: 'green', error: 'red', timed_out: 'red', proposed: 'amber', sent: 'amber' },
          state: { active: 'green', dormant: 'gray', archived: 'gray', running: 'green', exited: 'gray' },
          claim_state: { claimed: 'amber', unclaimed: 'gray' },
        },
        summary: { tasks: 'status', runs: 'status', souls: 'state', bets: 'status', containers: 'state' },
      },
    },
    // Intentionally no activity, commands, log paths, or document collections.
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 4690);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be between 1024 and 65535');
  const server = createApp(forkConfig());
  server.listen(port, '127.0.0.1', () => console.log(`NanoClaw dashboard: http://127.0.0.1:${port}`));
}
