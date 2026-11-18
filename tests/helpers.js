import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';

// Starts the app on a random port with a throwaway database file.
// Never point tests at data/money.db: it holds the owner's real data.
export async function startTestServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'money-monitoring-test-'));
  const db = openDb(path.join(dir, 'test.db'));
  const server = createApp({ db }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  return {
    db,
    baseUrl,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
