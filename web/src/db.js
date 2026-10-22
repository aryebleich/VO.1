// SQLite storage via Node's built-in node:sqlite (no native build step).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const file = process.env.DB_FILE || path.resolve('data/quantpocket.db');
if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
export const db = new DatabaseSync(file);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  phone TEXT UNIQUE,
  phone_verified INTEGER NOT NULL DEFAULT 0,
  phone_code TEXT,
  pin_hash TEXT,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  plan TEXT NOT NULL DEFAULT 'free',
  plan_renews INTEGER,
  stripe_customer TEXT,
  tax_bracket REAL NOT NULL DEFAULT 0.24,
  state_tax REAL NOT NULL DEFAULT 0.05,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mfa_pending INTEGER NOT NULL DEFAULT 0,
  ip TEXT, ua TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  event TEXT NOT NULL,
  detail TEXT,
  ip TEXT,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS credentials (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  blob TEXT NOT NULL,
  PRIMARY KEY (user_id, provider)
);
CREATE TABLE IF NOT EXISTS strategies (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  entry TEXT NOT NULL,
  exit TEXT NOT NULL,
  sl REAL, tp REAL, ts REAL,
  size REAL NOT NULL DEFAULT 100,
  deployed TEXT,
  last_run TEXT,
  last_action TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS paper_accounts (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  cash REAL NOT NULL,
  start_cash REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS positions (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account TEXT NOT NULL,
  symbol TEXT NOT NULL,
  qty REAL NOT NULL,
  avg_price REAL NOT NULL,
  PRIMARY KEY (user_id, account, symbol)
);
CREATE TABLE IF NOT EXISTS fills (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  qty REAL NOT NULL,
  price REAL NOT NULL,
  source TEXT NOT NULL,
  broker_order_id TEXT,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS equity_history (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account TEXT NOT NULL,
  day TEXT NOT NULL,
  equity REAL NOT NULL,
  PRIMARY KEY (user_id, account, day)
);
CREATE TABLE IF NOT EXISTS scheduled_orders (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  qty REAL,
  notional REAL,
  repeat TEXT NOT NULL DEFAULT 'once',
  next_run INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  last_result TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS fee_state (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account TEXT NOT NULL,
  high_water REAL NOT NULL,
  net_contrib REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, account)
);
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  amount REAL NOT NULL,
  status TEXT NOT NULL,
  ref TEXT,
  memo TEXT,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  op TEXT NOT NULL,
  price REAL NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
`);

export const one = (sql, ...a) => db.prepare(sql).get(...a);
export const all = (sql, ...a) => db.prepare(sql).all(...a);
export const run = (sql, ...a) => db.prepare(sql).run(...a);
export const now = () => Date.now();

export function audit(userId, event, detail, ip) {
  run('INSERT INTO audit_log (user_id, event, detail, ip, at) VALUES (?,?,?,?,?)', userId ?? null, event, detail ? JSON.stringify(detail) : null, ip ?? null, now());
}

export function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
