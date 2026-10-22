// Storage via libSQL: a local SQLite file by default, or a free hosted Turso database when
// DATABASE_URL (libsql://...) and DATABASE_AUTH_TOKEN are set.
import { createClient } from '@libsql/client';
import fs from 'node:fs';
import path from 'node:path';

const url = process.env.DATABASE_URL || 'file:' + (process.env.DB_FILE || path.resolve('data/quantpocket.db'));
if (url.startsWith('file:')) fs.mkdirSync(path.dirname(url.slice(5)), { recursive: true });
if (url.startsWith('file:') && process.env.RENDER) console.warn('WARNING: using a local SQLite file on Render. Free instances lose files on restart; set DATABASE_URL to a Turso database.');
export const db = createClient({ url, authToken: process.env.DATABASE_AUTH_TOKEN });

const SCHEMA = `
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
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  name TEXT, email TEXT NOT NULL,
  subject TEXT, body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
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
`;

// Columns added after the first release; ALTER fails harmlessly when they already exist.
const MIGRATIONS = [
  'ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE users ADD COLUMN reset_hash TEXT',
  'ALTER TABLE users ADD COLUMN reset_expires INTEGER',
  'ALTER TABLE users ADD COLUMN verify_hash TEXT',
];

export const ready = (async () => {
  if (url.startsWith('file:')) { await db.execute('PRAGMA journal_mode = WAL'); await db.execute('PRAGMA foreign_keys = ON'); }
  await db.executeMultiple(SCHEMA);
  for (const m of MIGRATIONS) await db.execute(m).catch(() => {});
})();

const plain = rs => rs.rows.map(r => Object.fromEntries(rs.columns.map((c, i) => [c, r[i]])));
const exec = async (sql, args) => { await ready; return db.execute({ sql, args: args.map(a => (a === undefined ? null : a)) }); };

export const one = async (sql, ...a) => plain(await exec(sql, a))[0];
export const all = async (sql, ...a) => plain(await exec(sql, a));
export const run = async (sql, ...a) => { const r = await exec(sql, a); return { changes: r.rowsAffected, lastInsertRowid: Number(r.lastInsertRowid ?? 0) }; };
export const now = () => Date.now();

export async function audit(userId, event, detail, ip) {
  await run('INSERT INTO audit_log (user_id, event, detail, ip, at) VALUES (?,?,?,?,?)', userId ?? null, event, detail ? JSON.stringify(detail) : null, ip ?? null, now());
}

// Runs fn inside a write transaction; fn receives one/all/run bound to it.
export async function tx(fn) {
  await ready;
  const t = await db.transaction('write');
  const q = async (sql, a) => t.execute({ sql, args: a.map(x => (x === undefined ? null : x)) });
  const h = {
    one: async (sql, ...a) => plain(await q(sql, a))[0],
    all: async (sql, ...a) => plain(await q(sql, a)),
    run: async (sql, ...a) => { const r = await q(sql, a); return { changes: r.rowsAffected, lastInsertRowid: Number(r.lastInsertRowid ?? 0) }; },
  };
  try { const r = await fn(h); await t.commit(); return r; } catch (e) { await t.rollback(); throw e; } finally { t.close(); }
}
