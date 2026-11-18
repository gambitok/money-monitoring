import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { categoriesRouter } from './routes/categories.js';
import { summaryRouter } from './routes/summary.js';
import { transactionsRouter } from './routes/transactions.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp({ db }) {
  const app = express();

  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (req, res) => {
    const { ok } = db.prepare('SELECT 1 AS ok').get();
    res.json({ ok: ok === 1, schemaVersion: db.pragma('user_version', { simple: true }) });
  });

  app.use('/api/transactions', transactionsRouter(db));
  app.use('/api/categories', categoriesRouter(db));
  app.use('/api/summary', summaryRouter(db));

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use(express.static(publicDir));

  // Express 5 forwards rejected async handlers here, so routes need no try/catch wrapper.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status ?? err.statusCode ?? 500;
    if (status >= 500) console.error(err);
    const body = { error: status >= 500 ? 'Internal server error' : err.message };
    if (err.fields) body.fields = err.fields;
    if (err.details) Object.assign(body, err.details);
    res.status(status).json(body);
  });

  return app;
}
