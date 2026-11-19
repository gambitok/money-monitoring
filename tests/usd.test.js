import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let ctx;
before(async () => { ctx = await startTestServer(); });
after(async () => { await ctx.close(); });

const rate = (query = '') => fetch(`${ctx.baseUrl}/api/usd-rate?${query}`).then(async (r) => ({ status: r.status, body: await r.json() }));

test('GET /api/usd-rate: null without data, period rate, all-time fallback, validation', async () => {
  assert.deepEqual((await rate()).body, { usd: null });

  const salary = ctx.db.prepare("SELECT id FROM categories WHERE type = 'income' LIMIT 1").pluck().get();
  const tx = ctx.db.prepare(`INSERT INTO transactions (type, amount_minor, occurred_on, category_id, description) VALUES ('income', ?, ?, ?, ?)`);
  tx.run(4400000, '2026-06-01', salary, '$1000 за курсом 44');
  tx.run(4100000, '2025-02-01', salary, '$1000 за курсом 41');

  assert.deepEqual((await rate('from=2026-06-01&to=2026-06-30')).body, { usd: { rate: 44, source: 'period' } });
  assert.deepEqual((await rate('from=2024-04-01&to=2024-04-30')).body, { usd: { rate: 42.5, source: 'all' } });
  assert.deepEqual((await rate()).body, { usd: { rate: 42.5, source: 'period' } });

  const bad = await rate('from=2026-02-30');
  assert.equal(bad.status, 400);
  assert.ok(bad.body.fields.from);
});
