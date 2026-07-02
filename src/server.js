'use strict';
const { openDb, migrate } = require('./db');
const { createApp } = require('./app');

const dbPath = process.env.DATABASE_PATH || './data/approval.db';
const port = Number(process.env.PORT || 3000);

const db = openDb(dbPath);
migrate(db);

const app = createApp(db);
app.listen(port, () => console.log(`approval-service listening on :${port} (db: ${dbPath})`));
