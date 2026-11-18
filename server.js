import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './src/db.js';
import { createApp } from './src/app.js';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT) || 3001;
const dbFile = process.env.DB_FILE || path.join(rootDir, 'data', 'money.db');

const db = openDb(dbFile);
const server = createApp({ db }).listen(port, () => {
  console.log(`money-monitoring: http://localhost:${port}  (db: ${dbFile})`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
