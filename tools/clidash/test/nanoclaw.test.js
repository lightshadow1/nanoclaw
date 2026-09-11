import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { hostname } from 'node:os';
import { createApp } from '../server.js';
import { forkConfig } from '../nanoclaw.js';

test('fork config exposes only fixed resources and no file or command controls', () => {
  const config = forkConfig('/test-root');
  assert.equal(config.privateOnly, true);
  assert.deepEqual(config.clis.nanoclaw.resources.map((r) => r.name), ['tasks','runs','souls','bets','containers']);
  assert.deepEqual(config.clis.nanoclaw.list, ['/test-root/dist/dashboard-cli.js','{resource}']);
  for (const key of ['logs','docs','activity']) assert.equal(config[key], undefined);
  assert.equal(config.clis.nanoclaw.commands, undefined);
});

test('all-interface mode accepts the server hostname while retaining origin checks', async () => {
  const config = forkConfig('/test-root', '0.0.0.0');
  assert.ok(config.allowedHosts.includes(hostname().toLowerCase()));
  assert.throws(() => forkConfig('/test-root', 'invalid'), /BIND/);
  const server = createApp(config);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const [origin, expected] of [[`http://${hostname()}`, 200], ['https://unrelated.example', 403]]) {
      const status = await new Promise((resolve, reject) => {
        const req = request(base + '/api/clis', { headers: { host: hostname(), origin } }, (res) => { res.resume(); resolve(res.statusCode); });
        req.on('error', reject); req.end();
      });
      assert.equal(status, expected);
    }
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('fork perimeter rejects cross-origin, non-local Host, mutations and file browsing', async () => {
  const server = createApp(forkConfig());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const headers of [{ origin: 'https://other.example' }, { host: 'rebind.example' }, { 'sec-fetch-site': 'cross-site' }]) {
      const status = await new Promise((resolve, reject) => {
        const req = request(base + '/api/clis', { headers }, (res) => { res.resume(); resolve(res.statusCode); });
        req.on('error', reject); req.end();
      });
      assert.equal(status, 403, JSON.stringify(headers));
    }
    assert.equal((await fetch(base + '/api/clis', { method: 'POST' })).status, 405);
    const response = await fetch(base + '/api/clis');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.deepEqual(await (await fetch(base + '/api/docs')).json(), { collections: [] });
    assert.deepEqual(await (await fetch(base + '/api/logs')).json(), { files: [] });
    assert.equal((await fetch(base + '/api/doc?c=secrets&p=.env')).status, 404);
    assert.notEqual((await fetch(base + '/api/r/nanoclaw/constructor')).status, 200);
    assert.notEqual((await fetch(base + '/api/cmd/nanoclaw/run?id=touch')).status, 200);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
