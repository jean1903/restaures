const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'restaures.sqlite'));

db.exec(`
  CREATE TABLE IF NOT EXISTS usuarios (
    id        TEXT PRIMARY KEY,
    email     TEXT UNIQUE NOT NULL,
    senha     TEXT NOT NULL,
    creditos  INTEGER NOT NULL DEFAULT 0,
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

module.exports = db;
