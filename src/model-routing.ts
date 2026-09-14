import fs from 'fs';
import { z } from 'zod';
import { readEnvFile } from './env.js';

const role = z.enum(['scout', 'analyst', 'synthesizer', 'builder']);
const schema = z.object({
  baseUrl: z.string().url().refine((value) => {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      && !url.search && !url.hash && !url.pathname.replace(/\/$/, '');
  }, 'Use the Aperture origin, without /v1 or credentials'),
  roles: z.partialRecord(role, z.union([
    z.string().trim().min(1),
    z.object({ model: z.string().trim().min(1), classificationModel: z.string().trim().min(1).optional() }).strict(),
  ])),
  tasks: z.record(z.string().min(1), role),
}).strict();

export interface ModelRoute {
  role: z.infer<typeof role>;
  model: string;
  baseUrl: string;
  classificationModel?: string;
}

export function parseModelRouting(value: unknown) {
  const config = schema.parse(value);
  for (const selected of Object.values(config.tasks)) {
    if (!config.roles[selected]) throw new Error(`No model configured for role ${selected}`);
  }
  return config;
}

// Exact task IDs only: prompts and tool arguments cannot select their own model.
// Read for each run, so operators can enable/disable routes without a restart.
export function resolveTaskModelRoute(taskId: string): ModelRoute | undefined {
  const env = readEnvFile(['MODEL_ROUTING_CONFIG']);
  const file = process.env.MODEL_ROUTING_CONFIG ?? env.MODEL_ROUTING_CONFIG;
  if (!file) return undefined;
  const config = parseModelRouting(JSON.parse(fs.readFileSync(file, 'utf8')));
  const selected = config.tasks[taskId];
  if (!selected) return undefined;
  const assignment = config.roles[selected]!;
  return { role: selected, ...(typeof assignment === 'string' ? { model: assignment } : assignment), baseUrl: config.baseUrl };
}
