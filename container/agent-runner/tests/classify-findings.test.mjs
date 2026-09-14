import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyFindings } from '../dist/classify-findings.js';

const findings = [{ id: 'one', topic: 'test', knownFacts: 'Version 1', finding: 'Version 2 released', sourceUrl: 'https://example.com/release', flagTrigger: 'New release' }];
const valid = { classifications: [{ id: 'one', materialChange: true, flagged: true, reason: 'Version changed' }] };
test('classification validates JSON, IDs, completion and persists paid usage on invalid output', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'classification-'));
  const original = globalThis.fetch;
  let content = JSON.stringify(valid), finish = 'stop';
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, 'https://gateway.example/v1/chat/completions');
      const body = JSON.parse(init.body);
      assert.equal(body.model, 'deepseek/test');
      assert.deepEqual(body.response_format, { type: 'json_object' });
      return new Response(JSON.stringify({ id: 'call', model: body.model, choices: [{ message: { content }, finish_reason: finish }], usage: { prompt_tokens: 100, completion_tokens: 20, cost: .001, prompt_tokens_details: { cached_tokens: 10 } } }));
    };
    const options = { baseUrl: 'https://gateway.example', model: 'deepseek/test', usagePath: path.join(dir, 'usage.jsonl') };
    assert.deepEqual(await classifyFindings(findings, options), valid);
    content = '```json\n' + JSON.stringify(valid) + '\n```';
    assert.deepEqual(await classifyFindings(findings, options), valid);
    for (const bad of [{ classifications: [] }, { classifications: [{ ...valid.classifications[0], id: 'other' }] }, { classifications: [{ ...valid.classifications[0], flagged: 'yes' }] }]) {
      content = JSON.stringify(bad);
      await assert.rejects(classifyFindings(findings, options));
    }
    content = JSON.stringify(valid); finish = 'length';
    await assert.rejects(classifyFindings(findings, options), /finish normally/);
    const rows = fs.readFileSync(options.usagePath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 6);
    assert.equal(rows[0].models['deepseek/test'].inputTokens, 90);
    assert.equal(rows[0].source, 'provider_reported');
    await assert.rejects(classifyFindings([...findings, ...findings], options), /unique/);
  } finally { globalThis.fetch = original; fs.rmSync(dir, { recursive: true, force: true }); }
});
