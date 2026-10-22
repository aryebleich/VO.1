// Accounts, sessions, TOTP two-factor, lockout, rate limits, CSRF guard.
import express from 'express';
import { one, all, run, now, audit, tx } from './db.js';
import { hashSecret, verifySecret, randomToken, sha256, newTotpSecret, verifyTotp } from './crypto.js';
import { sendEmail, emailEnabled } from './notify.js';

const SESSION_MS = 12 * 3600e3;
const MFA_MS = 5 * 60e3;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60e3;
const COOKIE = 'qp_sid';
const secure = process.env.NODE_ENV === 'production';

// Fixed-window limiter keyed by caller-supplied string.
const hits = new Map();
export function rateLimit(key, max, windowMs) {
  const t = now(), h = hits.get(key);
  if (!h || t - h.start > windowMs) { hits.set(key, { start: t, n: 1 }); return true; }
  h.n++;
  return h.n <= max;
}
setInterval(() => { const t = now(); for (const [k, h] of hits) if (t - h.start > 3600e3) hits.delete(k); }, 600e3).unref();

export function validPassword(p) {
  return typeof p === 'string' && p.length >= 10 && /[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p);
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}
function setCookie(res, token, ms) {
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(ms / 1000)}${secure ? '; Secure' : ''}`);
}
async function createSession(res, req, userId, mfaPending) {
  const token = randomToken();
  const ttl = mfaPending ? MFA_MS : SESSION_MS;
  await run('INSERT INTO sessions (token_hash, user_id, mfa_pending, ip, ua, created_at, expires_at) VALUES (?,?,?,?,?,?,?)',
    sha256(token), userId, mfaPending ? 1 : 0, req.ip, (req.headers['user-agent'] || '').slice(0, 200), now(), now() + ttl);
  setCookie(res, token, ttl);
}

// Attaches req.user for fully-authenticated sessions and req.pending for sessions awaiting 2FA.
export async function sessionMiddleware(req, _res, next) {
  const token = parseCookies(req)[COOKIE];
  if (token) {
    const s = await one('SELECT * FROM sessions WHERE token_hash = ?', sha256(token));
    if (s && s.expires_at > now()) {
      req.sessionHash = s.token_hash;
      const u = await one('SELECT * FROM users WHERE id = ?', s.user_id);
      if (s.mfa_pending) req.pending = u; else req.user = u;
    }
  }
  next();
}

// State-changing API calls must carry a custom header, which cross-site forms cannot set.
export function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.headers['x-requested-with'] !== 'qp') return res.status(403).json({ error: 'Missing CSRF header' });
  next();
}

export const requireUser = (req, res, next) => req.user ? next() : res.status(401).json({ error: 'Not signed in' });
export const requireAdmin = (req, res, next) => req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin only' });

export const publicUser = u => u && ({
  id: u.id, email: u.email, role: u.role, totpEnabled: !!u.totp_enabled, phone: u.phone, phoneVerified: !!u.phone_verified,
  hasPin: !!u.pin_hash, emailVerified: !!u.email_verified, plan: u.plan, planRenews: u.plan_renews, taxBracket: u.tax_bracket, stateTax: u.state_tax,
});

export const router = express.Router();

router.post('/register', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const { password } = req.body;
  if (!rateLimit('reg:' + req.ip, 10, 3600e3)) return res.status(429).json({ error: 'Too many sign-ups from this address' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email' });
  if (!validPassword(password)) return res.status(400).json({ error: 'Password needs 10+ characters with upper, lower and a digit' });
  if (await one('SELECT id FROM users WHERE email = ?', email)) return res.status(409).json({ error: 'Email already registered' });
  // Admin is whoever matches ADMIN_EMAIL; outside production the first account also qualifies.
  const admin = process.env.ADMIN_EMAIL ? email === process.env.ADMIN_EMAIL.toLowerCase()
    : process.env.NODE_ENV !== 'production' && !await one('SELECT id FROM users LIMIT 1');
  const r = await run('INSERT INTO users (email, pass_hash, role, created_at) VALUES (?,?,?,?)', email, hashSecret(password), admin ? 'admin' : 'user', now());
  const id = Number(r.lastInsertRowid);
  await run('INSERT INTO paper_accounts (user_id, cash, start_cash) VALUES (?,?,?)', id, 100000, 100000);
  await run('INSERT INTO fee_state (user_id, account, high_water, net_contrib) VALUES (?,?,?,?)', id, 'paper', 100000, 100000);
  await audit(id, 'register', null, req.ip);
  await sendVerification(id, email).catch(e => console.warn('verify email', e.message));
  await createSession(res, req, id, false);
  res.json({ user: publicUser(await one('SELECT * FROM users WHERE id = ?', id)) });
});

router.post('/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!rateLimit('login:' + req.ip, 20, 15 * 60e3)) return res.status(429).json({ error: 'Too many attempts, try later' });
  const u = await one('SELECT * FROM users WHERE email = ?', email);
  if (u && u.locked_until > now()) return res.status(423).json({ error: 'Account temporarily locked after failed attempts' });
  if (!u || !verifySecret(String(req.body.password || ''), u.pass_hash)) {
    if (u) {
      const fails = u.failed_logins + 1;
      await run('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?', fails >= MAX_FAILS ? 0 : fails, fails >= MAX_FAILS ? now() + LOCK_MS : 0, u.id);
      await audit(u.id, 'login_failed', null, req.ip);
    }
    return res.status(401).json({ error: 'Wrong email or password' });
  }
  await run('UPDATE users SET failed_logins = 0, locked_until = 0 WHERE id = ?', u.id);
  await createSession(res, req, u.id, !!u.totp_enabled);
  await audit(u.id, u.totp_enabled ? 'login_password_ok' : 'login', null, req.ip);
  res.json(u.totp_enabled ? { mfaRequired: true } : { user: publicUser(u) });
});

router.post('/mfa', async (req, res) => {
  const u = req.pending;
  if (!u) return res.status(401).json({ error: 'Sign in first' });
  if (!rateLimit('mfa:' + u.id, 6, 5 * 60e3)) return res.status(429).json({ error: 'Too many codes' });
  if (!verifyTotp(u.totp_secret, req.body.code)) { await audit(u.id, 'mfa_failed', null, req.ip); return res.status(401).json({ error: 'Invalid code' }); }
  await run('DELETE FROM sessions WHERE token_hash = ?', req.sessionHash);
  await createSession(res, req, u.id, false);
  await audit(u.id, 'login', { mfa: true }, req.ip);
  res.json({ user: publicUser(u) });
});

router.post('/logout', async (req, res) => {
  if (req.sessionHash) await run('DELETE FROM sessions WHERE token_hash = ?', req.sessionHash);
  setCookie(res, '', 0);
  res.json({ ok: true });
});

router.get('/me', async (req, res) => res.json({ user: publicUser(req.user) || null, mfaPending: !!req.pending }));

router.post('/totp/setup', requireUser, async (req, res) => {
  const secret = newTotpSecret();
  await run('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?', secret, req.user.id);
  const uri = `otpauth://totp/QuantPocket:${encodeURIComponent(req.user.email)}?secret=${secret}&issuer=QuantPocket`;
  res.json({ secret, uri });
});
router.post('/totp/enable', requireUser, async (req, res) => {
  if (!verifyTotp(req.user.totp_secret, req.body.code)) return res.status(400).json({ error: 'Code does not match' });
  await run('UPDATE users SET totp_enabled = 1 WHERE id = ?', req.user.id);
  await audit(req.user.id, 'totp_enabled', null, req.ip);
  res.json({ ok: true });
});
router.post('/totp/disable', requireUser, async (req, res) => {
  if (!verifySecret(String(req.body.password || ''), req.user.pass_hash)) return res.status(401).json({ error: 'Wrong password' });
  await run('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?', req.user.id);
  await audit(req.user.id, 'totp_disabled', null, req.ip);
  res.json({ ok: true });
});

router.post('/password', requireUser, async (req, res) => {
  if (!verifySecret(String(req.body.current || ''), req.user.pass_hash)) return res.status(401).json({ error: 'Wrong current password' });
  if (!validPassword(req.body.next)) return res.status(400).json({ error: 'Password needs 10+ characters with upper, lower and a digit' });
  await run('UPDATE users SET pass_hash = ? WHERE id = ?', hashSecret(req.body.next), req.user.id);
  await run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', req.user.id, req.sessionHash);
  await audit(req.user.id, 'password_changed', null, req.ip);
  res.json({ ok: true });
});

router.get('/sessions', requireUser, async (req, res) => {
  res.json((await all('SELECT token_hash, ip, ua, created_at, expires_at FROM sessions WHERE user_id = ? AND mfa_pending = 0 AND expires_at > ? ORDER BY created_at DESC', req.user.id, now()))
    .map(s => ({ id: s.token_hash.slice(0, 16), current: s.token_hash === req.sessionHash, ip: s.ip, ua: s.ua, createdAt: s.created_at })));
});
router.delete('/sessions/:id', requireUser, async (req, res) => {
  await run("DELETE FROM sessions WHERE user_id = ? AND substr(token_hash, 1, 16) = ?", req.user.id, req.params.id);
  res.json({ ok: true });
});
router.get('/audit', requireUser, async (req, res) => {
  res.json(await all('SELECT event, detail, ip, at FROM audit_log WHERE user_id = ? ORDER BY id DESC LIMIT 50', req.user.id));
});

const appUrl = () => (process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, '');

async function sendVerification(userId, email) {
  const token = randomToken();
  await run('UPDATE users SET verify_hash = ? WHERE id = ?', sha256(token), userId);
  return sendEmail(email, 'Confirm your QuantPocket email',
    `Welcome to QuantPocket.\n\nConfirm your email address:\n${appUrl()}/app#/verify?token=${token}\n\nIf you did not sign up, ignore this message.`);
}

router.post('/verify/resend', requireUser, async (req, res) => {
  if (!rateLimit('verify:' + req.user.id, 3, 3600e3)) return res.status(429).json({ error: 'Try again later' });
  await sendVerification(req.user.id, req.user.email);
  res.json({ ok: true, simulated: !emailEnabled() });
});
router.post('/verify', async (req, res) => {
  const u = await one('SELECT id FROM users WHERE verify_hash = ?', sha256(String(req.body.token || '')));
  if (!u) return res.status(400).json({ error: 'This link is invalid or was already used' });
  await run('UPDATE users SET email_verified = 1, verify_hash = NULL WHERE id = ?', u.id);
  await audit(u.id, 'email_verified', null, req.ip);
  res.json({ ok: true });
});

// Always answers the same way so the form cannot be used to discover registered emails.
router.post('/forgot', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!rateLimit('forgot:' + req.ip, 5, 3600e3)) return res.status(429).json({ error: 'Too many requests, try later' });
  const u = await one('SELECT id FROM users WHERE email = ?', email);
  if (u) {
    const token = randomToken();
    await run('UPDATE users SET reset_hash = ?, reset_expires = ? WHERE id = ?', sha256(token), now() + 3600e3, u.id);
    await sendEmail(email, 'Reset your QuantPocket password',
      `Someone asked to reset your password.\n\nChoose a new one (link valid for 1 hour):\n${appUrl()}/app#/reset?token=${token}\n\nIf this was not you, ignore this message.`).catch(e => console.warn('reset email', e.message));
    await audit(u.id, 'password_reset_requested', null, req.ip);
  }
  res.json({ ok: true });
});
router.post('/reset', async (req, res) => {
  const u = await one('SELECT * FROM users WHERE reset_hash = ? AND reset_expires > ?', sha256(String(req.body.token || '')), now());
  if (!u) return res.status(400).json({ error: 'This link is invalid or expired' });
  if (!validPassword(req.body.password)) return res.status(400).json({ error: 'Password needs 10+ characters with upper, lower and a digit' });
  await run('UPDATE users SET pass_hash = ?, reset_hash = NULL, reset_expires = NULL, failed_logins = 0, locked_until = 0, email_verified = 1 WHERE id = ?', hashSecret(req.body.password), u.id);
  await run('DELETE FROM sessions WHERE user_id = ?', u.id);
  await audit(u.id, 'password_reset', null, req.ip);
  res.json({ ok: true });
});

// Privacy: download everything stored about the account, or delete it.
router.get('/export', requireUser, async (req, res) => {
  const id = req.user.id, t = sql => all(sql, id);
  const data = {
    profile: publicUser(req.user),
    strategies: await t('SELECT * FROM strategies WHERE user_id = ?'),
    fills: await t('SELECT * FROM fills WHERE user_id = ?'),
    positions: await t('SELECT * FROM positions WHERE user_id = ?'),
    scheduled: await t('SELECT * FROM scheduled_orders WHERE user_id = ?'),
    alerts: await t('SELECT * FROM alerts WHERE user_id = ?'),
    ledger: await t('SELECT * FROM ledger WHERE user_id = ?'),
    securityLog: await t('SELECT event, ip, at FROM audit_log WHERE user_id = ?'),
  };
  res.attachment('quantpocket-export.json').json(data);
});
router.post('/delete', requireUser, async (req, res) => {
  if (!verifySecret(String(req.body.password || ''), req.user.pass_hash)) return res.status(401).json({ error: 'Wrong password' });
  await audit(null, 'account_deleted', { id: req.user.id }, req.ip);
  // Explicit deletes: hosted libSQL does not always enforce ON DELETE CASCADE.
  await tx(async ({ run }) => {
    for (const t of ['sessions', 'credentials', 'strategies', 'paper_accounts', 'positions', 'fills', 'equity_history', 'scheduled_orders', 'fee_state', 'ledger', 'alerts'])
      await run(`DELETE FROM ${t} WHERE user_id = ?`, req.user.id);
    await run('DELETE FROM users WHERE id = ?', req.user.id);
  });
  setCookie(res, '', 0);
  res.json({ ok: true });
});
