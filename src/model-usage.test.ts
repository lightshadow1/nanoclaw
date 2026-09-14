import { expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { appendModelUsage } from './model-usage.js';

it('appends per-model accounting including cache tokens and labels estimates', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-usage-'));
  try {
    const report = { resultId: 'result-1', models: { 'deepseek/test': { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40, costUSD: 0.01 } } };
    appendModelUsage(dir, report, { runId: 'run-1', group: 'main', role: 'scout' });
    appendModelUsage(dir, { ...report, resultId: 'result-2' }, { runId: 'run-2', group: 'main' });
    const rows = fs.readFileSync(path.join(dir, 'token_usage.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ runId: 'run-1', role: 'scout', model: 'deepseek/test', total_tokens: 100, estimated_cost_usd: 0.01, granularity: 'sdk_result', cost_source: 'claude_agent_sdk_estimate_not_provider_billing' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
