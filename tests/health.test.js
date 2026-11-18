import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let ctx;
before(async () => { ctx = await startTestServer(); });
after(async () => { await ctx.close(); });

test('GET /api/health reports a working database', async () => {
  const res = await fetch(`${ctx.baseUrl}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.schemaVersion, 'number');
});

test('unknown API routes return JSON 404', async () => {
  const res = await fetch(`${ctx.baseUrl}/api/nope`);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'Not found' });
});

test('serves the frontend', async () => {
  const res = await fetch(`${ctx.baseUrl}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Money Monitoring/);
});
