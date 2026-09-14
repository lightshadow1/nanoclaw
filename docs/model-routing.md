# Scheduled workload model routing

NanoClaw's intelligence filter is implemented by scheduled tasks, not separate
Python Scout/Analyst agents. Routing is an explicit task-ID mapping. Interactive
chat and tasks without a mapping retain their existing Claude configuration.

Set `MODEL_ROUTING_CONFIG` in the host `.env` to an operator-managed JSON file
outside group workspaces. The file is read at the start of each scheduled run:

```json
{
  "baseUrl": "https://will-corp.tail0a0a8f.ts.net",
  "roles": {
    "scout": {
      "model": "claude-sonnet-4-6",
      "classificationModel": "deepseek/deepseek-v4-flash-0731"
    },
    "analyst": "claude-sonnet-4-6",
    "synthesizer": "claude-sonnet-4-6",
    "builder": "claude-sonnet-4-6"
  },
  "tasks": {
    "task-1779934568728-ovail9": "scout",
    "soul-wiki-curation-main": "analyst",
    "soul-evening-journal-main": "synthesizer",
    "soul-production-main": "builder"
  }
}
```

Scout keeps Claude for research and tools. Its `classify_findings` MCP tool sends
up to 20 researched findings to DeepSeek using OpenAI-compatible chat completions.
The tool validates JSON types and exact input/output ID coverage, rejects
truncated results, and reports errors instead of silently substituting Claude.
Classification is advisory; Scout verifies flagged claims before publication.
The deployed Claude SDK cannot run a whole DeepSeek task through the current
OpenRouter route, even though standalone DeepSeek API calls succeed.
The gateway also did not advertise the requested V4.1 Flash Analyst ID during
inspection. Analyst therefore stays on Claude initially.

Routed tasks start fresh sessions rather than resuming the interactive session.
They retain the existing capability profile, skill binding, container isolation,
and absolute timeout. Provider credentials stay in Aperture; NanoClaw passes only
placeholder authentication to the SDK. Use the gateway origin without `/v1`.

## Accounting

`runs/token_usage.jsonl` receives one row per model per SDK result, including
helper-model calls and cache tokens. Each row identifies its container run,
task, role, requested model, actual SDK-reported model, and result UUID.
Scheduled run `execution_context` includes the selected route, number of SDK
usage results, and their summed cost estimate.

Classification calls produce additional rows with `granularity: api_call` and
`cost_source: provider_reported` when the gateway returns cost (null otherwise).
Records are buffered inside the container until the next result/error; a
force-killed container can lose these buffered records. Invalid JSON responses
still record returned token usage. Run summaries combine SDK estimates and
available classification costs, and are not complete billing records.

Agent-loop costs are **SDK estimates, not provider billing**. Non-Claude pricing may not
be represented accurately by the SDK. Missing usage is null in the run summary,
not zero. Interrupted runs may have incomplete accounting. Aperture/OpenRouter
usage records remain authoritative for charges. No static price table is used.

This does not impose JSON on the entire agent loop: those responses contain
tool calls and user-facing text. Structured classification should validate its
own schema at a dedicated inference boundary.

## Rollback

Unset `MODEL_ROUTING_CONFIG` (or remove individual task mappings) to restore
direct-Claude behavior on the next run, using the existing Anthropic credentials.
An invalid routing file fails the task explicitly; gateway errors never silently
reroute a partially executed task to another provider.

## References

- [OpenRouter Claude Code integration](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration)
- [Aperture Claude Code setup](https://tailscale.com/docs/aperture/how-to/use-claude-code)
