// Fork-specific launcher: fixed read-only commands and configurable networking.
import { hostname, networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createApp } from './server.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function forkConfig(projectRoot = root, bind = '127.0.0.1') {
  if (!isIP(bind)) throw new Error('BIND must be an IP address');
  const allowedHosts = ['localhost', '127.0.0.1', '[::1]'];
  if (bind !== '127.0.0.1' && bind !== '::1') {
    allowedHosts.push(hostname().toLowerCase(), ...Object.values(networkInterfaces()).flat().filter(Boolean).map((entry) => entry.family === 'IPv6' ? `[${entry.address}]` : entry.address));
  }
  return {
    privateOnly: true,
    allowedHosts,
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
  const bind = process.env.BIND || '127.0.0.1';
  const server = createApp(forkConfig(root, bind));
  server.listen(port, bind, () => console.log(`NanoClaw dashboard listening on ${bind}:${port}`));
}
