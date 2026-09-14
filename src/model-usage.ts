import fs from 'fs';
import path from 'path';

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
}

export interface UsageReport {
  resultId: string;
  models: Record<string, ModelUsage>;
  source?: 'provider_reported' | 'provider_usage_without_cost';
}

// SDK result-level accounting includes tool-loop calls and helper models.
// SDK costs are estimates, not OpenRouter billing; retain that distinction.
export function appendModelUsage(
  directory: string,
  report: UsageReport,
  context: { runId: string; taskId?: string; group: string; role?: string; requestedModel?: string },
): void {
  fs.mkdirSync(directory, { recursive: true });
  const rows = Object.entries(report.models).map(([model, usage]) => JSON.stringify({
    timestamp: new Date().toISOString(),
    ...context,
    resultId: report.resultId,
    model,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_read_tokens: usage.cacheReadInputTokens,
    cache_write_tokens: usage.cacheCreationInputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens,
    estimated_cost_usd: report.source === 'provider_usage_without_cost' ? null : usage.costUSD,
    cost_source: report.source ?? 'claude_agent_sdk_estimate_not_provider_billing',
    granularity: report.source ? 'api_call' : 'sdk_result',
  }));
  if (rows.length) fs.appendFileSync(path.join(directory, 'token_usage.jsonl'), rows.join('\n') + '\n', { mode: 0o600 });
}
