import { describe, expect, it, vi, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseModelRouting, resolveTaskModelRoute } from './model-routing.js';

const config = { baseUrl: 'https://gateway.example', roles: { scout: 'deepseek/test', analyst: 'claude-sonnet-4-6' }, tasks: { 'weekly-scout': 'scout' } };
afterEach(() => vi.unstubAllEnvs());

describe('explicit scheduled model routing', () => {
  it('routes only named tasks and supports disabling routing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-routing-'));
    try {
      const file = path.join(dir, 'routes.json');
      fs.writeFileSync(file, JSON.stringify(config));
      vi.stubEnv('MODEL_ROUTING_CONFIG', file);
      expect(resolveTaskModelRoute('weekly-scout')).toEqual({ role: 'scout', model: 'deepseek/test', baseUrl: config.baseUrl });
      expect(resolveTaskModelRoute('unrelated')).toBeUndefined();
      fs.writeFileSync(file, JSON.stringify({ ...config, roles: { scout: { model: 'claude-sonnet-4-6', classificationModel: 'deepseek/test' } } }));
      expect(resolveTaskModelRoute('weekly-scout')).toMatchObject({ model: 'claude-sonnet-4-6', classificationModel: 'deepseek/test' });
      vi.stubEnv('MODEL_ROUTING_CONFIG', '');
      expect(resolveTaskModelRoute('weekly-scout')).toBeUndefined();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('rejects undefined roles and missing models instead of silently changing providers', () => {
    expect(() => parseModelRouting({ ...config, tasks: { x: 'unknown' } })).toThrow();
    expect(() => parseModelRouting({ ...config, tasks: { x: 'builder' } })).toThrow();
  });
  it('rejects URLs with credentials or /v1 paths', () => {
    for (const baseUrl of ['https://key:secret@gateway.example', 'https://gateway.example/v1', 'file:///tmp/gateway']) {
      expect(() => parseModelRouting({ ...config, baseUrl })).toThrow();
    }
  });
});
