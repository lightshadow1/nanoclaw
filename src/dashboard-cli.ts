import path from 'node:path';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  DASHBOARD_RESOURCES,
  readDashboardContainers,
  readDashboardRows,
} from './dashboard-data.js';

export async function dashboardCli(args: string[]): Promise<unknown[]> {
  if (args.length !== 1 || !DASHBOARD_RESOURCES.some((r) => r === args[0])) {
    throw new Error(`Usage: dashboard-cli <${DASHBOARD_RESOURCES.join('|')}>`);
  }
  if (args[0] === 'containers') return readDashboardContainers();
  return readDashboardRows(path.resolve('store/messages.db'), args[0]);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  dashboardCli(process.argv.slice(2)).then(
    (rows) => process.stdout.write(JSON.stringify(rows) + '\n'),
    (error: Error) => {
      process.stderr.write(error.message + '\n');
      process.exitCode = 1;
    },
  );
}
