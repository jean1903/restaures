const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'restaures.sqlite'));

db.exec(`
  CREATE TABLE IF NOT EXISTS usuarios (
    id          TEXT PRIMARY KEY,
    email       TEXT UNIQUE NOT NULL,
    creditos    INTEGER NOT NULL DEFAULT 0,
    criado_em   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tokens (
    token       TEXT PRIMARY KEY,
    email       TEXT NOT NULL,
    expira_em   INTEGER NOT NULL,
    usado       INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS pagamentos (
    id          TEXT PRIMARY KEY,
    email       TEXT NOT NULL,
    plano       TEXT NOT NULL,
    creditos    INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pendente',
    criado_em   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS uso (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    email       TEXT NOT NULL,
    criado_em   TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

module.exports = db;
