// QuantPocket web server: JSON API + static single-page app.
import express from 'express';
import compression from 'compression';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { one, all, run, now, audit } from './src/db.js';
import { encrypt, hashSecret, verifySecret } from './src/crypto.js';
import * as auth from './src/auth.js';
import { backtest, projectAnnual, walkForward, optimize, warmupFor, PRESETS } from './src/engine.js';
import { getBars, getCred, accountSummary, placeOrder, listOrders, portfolioHistory, lastPrice, snapshotEquity } from './src/brokers.js';
import * as QC from './src/quantconnect.js';
import { PLANS, adjustForCashflow, revenueSummary } from './src/fees.js';
import { taxSummary, harvestCandidates, form8949Csv } from './src/tax.js';
import { buildStrategy } from './src/ai.js';
import { handleCommand, userByPhone, HELP } from './src/commands.js';
import { startScheduler, assessAllFees, runScheduledOrders, runBots, runAlerts, snapshotAll, marketOpen } from './src/scheduler.js';
import * as N from './src/notify.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_URL = (process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, '');
export const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(compression());

// Minimal access log (no query strings: reset/verify tokens live in the URL fragment, but be safe).
app.use((req, res, next) => {
  const t = Date.now();
  res.on('finish', () => { if (!req.path.startsWith('/assets')) console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - t}ms`); });
  next();
});

app.get('/healthz', async (req, res) => {
  try { await one('SELECT 1 AS ok'); res.json({ ok: true, time: new Date().toISOString() }); }
  catch (e) { res.status(503).json({ ok: false }); }
});

// Free hosts sleep idle apps, so a GitHub Actions cron calls this to run due jobs.
app.post('/internal/tick', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ error: 'unauthorized' });
  const out = { orders: await runScheduledOrders(), bots: await runBots() };
  if (marketOpen()) await runAlerts();
  if (req.query.snapshot) await snapshotAll();
  res.json(out);
});

app.get('/robots.txt', (req, res) => res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /app\nSitemap: ${PUBLIC_URL}/sitemap.xml\n`));
app.get('/sitemap.xml', (req, res) => res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/', '/pricing', '/terms', '/privacy', '/risk', '/contact'].map(u => `<url><loc>${PUBLIC_URL}${u}</loc></url>`).join('')}</urlset>`));
// The browser demo on the landing page reuses the exact engine the server runs.
app.get('/config.js', (req, res) => res.type('text/javascript').send('window.QP = { api: "" };'));
app.get('/engine.js', (req, res) => res.type('text/javascript').sendFile(path.join(here, 'src/engine.js')));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://checkout.stripe.com");
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (process.env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// Stripe needs the raw body for signature checks, so mount it before the JSON parser.
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const raw = req.body.toString('utf8');
  if (!N.verifyStripe(raw, req.headers['stripe-signature'])) return res.status(400).send('bad signature');
  const ev = JSON.parse(raw), o = ev.data.object;
  try {
    if (ev.type === 'checkout.session.completed' && o.metadata?.kind === 'subscription') {
      const plan = o.metadata.plan in PLANS ? o.metadata.plan : 'free';
      await run('UPDATE users SET plan = ?, stripe_customer = ?, plan_renews = ? WHERE id = ?', plan, o.customer, now() + 31 * 86400e3, +o.client_reference_id);
      await run('INSERT INTO ledger (user_id, kind, amount, status, ref, memo, at) VALUES (?,?,?,?,?,?,?)', +o.client_reference_id, 'subscription', PLANS[plan].monthly, 'paid', o.id, `${PLANS[plan].name} plan`, now());
    } else if (ev.type === 'checkout.session.completed' && o.metadata?.kind === 'deposit') {
      const id = +o.metadata.ledger_id;
      const funding = await N.cardFunding(o.payment_intent);
      if (funding !== 'debit') {
        await N.refund(o.payment_intent);
        await run("UPDATE ledger SET status = 'refunded', memo = 'Only debit cards are accepted' WHERE id = ?", id);
      } else {
        // Card funds land in the platform's Stripe balance; moving them into the user's
        // brokerage account requires the Alpaca Broker API (see README, "Funding").
        await run("UPDATE ledger SET status = 'received', ref = ? WHERE id = ?", o.payment_intent, id);
      }
    } else if (ev.type === 'customer.subscription.deleted') {
      await run("UPDATE users SET plan = 'free', plan_renews = NULL WHERE stripe_customer = ?", o.customer);
    }
  } catch (e) { console.error('stripe webhook', e); return res.status(500).send('error'); }
  res.json({ received: true });
});

app.use(express.json({ limit: '200kb' }));
app.use(express.urlencoded({ extended: false, limit: '50kb' }));
app.use(auth.sessionMiddleware);

// ---------- Twilio: SMS + voice hotline (validated by Twilio signature, not session) ----------
const twiml = (res, body) => res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`);
const twilioOk = req => N.validTwilioSignature(PUBLIC_URL + req.originalUrl, req.body, req.headers['x-twilio-signature']);

app.post('/twilio/sms', async (req, res) => {
  if (!twilioOk(req)) return res.status(403).send('forbidden');
  const user = await userByPhone(req.body.From);
  let reply;
  if (!user) reply = 'This number is not linked to a QuantPocket account. Add it under Settings > Phone.';
  else if (!auth.rateLimit('sms:' + user.id, 30, 3600e3)) reply = 'Too many messages, try again later.';
  else {
    try { reply = await handleCommand(user, req.body.Body); } catch (e) { reply = 'Error: ' + e.message; }
    await audit(user.id, 'sms_command', { cmd: String(req.body.Body).split(/\s+/)[0] }, req.body.From);
  }
  twiml(res, `<Message>${N.xml(reply)}</Message>`);
});

const calls = new Map(); // CallSid -> { userId, tries }
app.post('/twilio/voice', async (req, res) => {
  if (!twilioOk(req)) return res.status(403).send('forbidden');
  const user = await userByPhone(req.body.From);
  if (!user || !user.pin_hash) return twiml(res, '<Say>This phone number is not linked to an account with a PIN. Goodbye.</Say><Hangup/>');
  calls.set(req.body.CallSid, { userId: user.id, tries: 0, ok: false });
  twiml(res, '<Gather input="dtmf" finishOnKey="#" action="/twilio/voice/pin" timeout="8"><Say>Welcome to QuantPocket. Enter your PIN, then press pound.</Say></Gather><Say>No input. Goodbye.</Say>');
});
app.post('/twilio/voice/pin', async (req, res) => {
  if (!twilioOk(req)) return res.status(403).send('forbidden');
  const c = calls.get(req.body.CallSid);
  if (!c) return twiml(res, '<Hangup/>');
  const u = await one('SELECT * FROM users WHERE id = ?', c.userId);
  if (!verifySecret(String(req.body.Digits || ''), u.pin_hash)) {
    if (++c.tries >= 3) { calls.delete(req.body.CallSid); await audit(u.id, 'hotline_pin_failed', null, req.body.From); return twiml(res, '<Say>Too many attempts. Goodbye.</Say><Hangup/>'); }
    return twiml(res, '<Gather input="dtmf" finishOnKey="#" action="/twilio/voice/pin"><Say>Wrong PIN. Try again.</Say></Gather>');
  }
  c.ok = true;
  twiml(res, menu());
});
const menu = () => '<Gather input="dtmf speech" numDigits="1" action="/twilio/voice/cmd" speechTimeout="auto" timeout="8"><Say>Press 1 for balance, 2 for positions, 3 for scheduled trades, 9 to pause all bots. Or say a command, like buy five shares of Apple.</Say></Gather><Say>Goodbye.</Say>';
app.post('/twilio/voice/cmd', async (req, res) => {
  if (!twilioOk(req)) return res.status(403).send('forbidden');
  const c = calls.get(req.body.CallSid);
  if (!c?.ok) return twiml(res, '<Hangup/>');
  const u = await one('SELECT * FROM users WHERE id = ?', c.userId);
  const text = { 1: 'BAL', 2: 'POS', 3: 'ORDERS', 9: 'PAUSE' }[req.body.Digits] || req.body.SpeechResult || 'HELP';
  let reply;
  try { reply = await handleCommand(u, text, { pinVerified: true }); } catch (e) { reply = 'Error. ' + e.message; }
  await audit(u.id, 'hotline_command', { text }, req.body.From);
  twiml(res, `<Say>${N.xml(reply.replace(/\$/g, ' dollars ').replace(/\n/g, '. '))}</Say>${menu()}`);
});
app.post('/twilio/voice/status', async (req, res) => { calls.delete(req.body.CallSid); res.sendStatus(204); });

// ---------- JSON API ----------
const api = express.Router();
// The landing page copy on GitHub Pages calls the public demo endpoints cross-origin (no cookies).
const PUBLIC_ORIGINS = (process.env.PUBLIC_ORIGINS || 'https://aryebleich.github.io').split(',').map(o => o.trim());
api.use('/public', (req, res, next) => {
  if (PUBLIC_ORIGINS.includes(req.headers.origin)) {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');
    res.setHeader('Access-Control-Allow-Methods', 'POST');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
api.use(auth.csrfGuard);
api.use('/auth', auth.router);
const U = auth.requireUser;
const wrap = fn => async (req, res) => Promise.resolve(fn(req, res)).catch(e => res.status(400).json({ error: e.message }));
const acct = req => (req.query.account || req.body?.account) === 'alpaca' ? 'alpaca' : 'paper';
const PAID = ['pro', 'elite'];
const needPlan = (req, res, next) => (PAID.includes(req.user.plan) || req.user.role === 'admin' ? next() : res.status(402).json({ error: 'This feature needs the Pro or Elite plan' }));

api.get('/config', async (req, res) => res.json({
  plans: PLANS, presets: PRESETS, twilio: N.twilioEnabled(), stripe: N.stripeEnabled(), ai: !!process.env.ANTHROPIC_API_KEY, email: N.emailEnabled(),
  marketData: !!process.env.ALPACA_KEY_ID, hotline: process.env.TWILIO_FROM || null,
}));

// Public, rate-limited demo backtest used by the landing page (also from the GitHub Pages copy).
api.post('/public/backtest', async (req, res) => {
  if (!auth.rateLimit('pub:' + req.ip, 20, 600e3)) return res.status(429).json({ error: 'Demo limit reached - create a free account for unlimited backtests' });
  const b = req.body || {}, symbol = String(b.symbol || 'SPY').toUpperCase().slice(0, 8);
  const preset = PRESETS[b.preset] || PRESETS['SMA cross'];
  const bars = await getBars(symbol, '2015-01-01', null);
  const cfg = { ...preset, capital: 10000 }, warm = warmupFor(cfg);
  const r = backtest(bars.closes, cfg, warm, bars.closes.length, bars.dates);
  const step = Math.max(1, Math.floor(r.eq.length / 200));
  res.json({ symbol, source: bars.source, m: r.m, projection: projectAnnual(r.eq), curve: r.eq.filter((_, i) => i % step === 0), bh: r.bh.filter((_, i) => i % step === 0) });
});
api.post('/public/contact', async (req, res) => {
  const { name, email, subject, body } = req.body || {};
  if (!auth.rateLimit('contact:' + req.ip, 5, 3600e3)) return res.status(429).json({ error: 'Too many messages, try later' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email)) || !String(body || '').trim()) return res.status(400).json({ error: 'Email and message are required' });
  await run('INSERT INTO messages (user_id, name, email, subject, body, at) VALUES (?,?,?,?,?,?)', req.user?.id ?? null, String(name || '').slice(0, 100), String(email).slice(0, 200), String(subject || '').slice(0, 200), String(body).slice(0, 5000), now());
  if (process.env.ADMIN_EMAIL) N.sendEmail(process.env.ADMIN_EMAIL, `[QuantPocket] ${subject || 'New message'}`, `From: ${name} <${email}>\n\n${body}`).catch(() => {});
  res.json({ ok: true });
});

api.post('/backtest', U, wrap(async (req, res) => {
  const b = req.body, start = b.start || '2016-01-01';
  if (!auth.rateLimit('bt:' + req.user.id, 60, 60e3)) throw new Error('Slow down - too many backtests');
  const bars = await getBars(String(b.symbol || 'SPY'), start, req.user.id);
  const cfg = { entry: b.entry, exit: b.exit, sl: b.sl, tp: b.tp, ts: b.ts, size: b.size, cost: b.cost, capital: b.capital || 10000 };
  const warm = warmupFor(cfg);
  if (/\{/.test(cfg.entry + cfg.exit)) {
    if (!PAID.includes(req.user.plan) && req.user.role !== 'admin') throw new Error('The optimizer needs the Elite or Pro plan');
    return res.json({ optimize: optimize(bars.closes, cfg, warm, bars.dates), source: bars.source });
  }
  const r = backtest(bars.closes, cfg, warm, bars.closes.length, bars.dates);
  const step = Math.max(1, Math.floor(r.eq.length / 400));
  res.json({
    source: bars.source, symbol: String(b.symbol).toUpperCase(), m: r.m, holding: r.holding, trades: r.trades.slice(-100),
    curve: r.eq.filter((_, i) => i % step === 0 || i === r.eq.length - 1).map((v, j) => ({ d: r.dates[Math.min(j * step, r.dates.length - 1)], eq: v, bh: r.bh[Math.min(j * step, r.bh.length - 1)] })),
    projection: projectAnnual(r.eq), walkForward: walkForward(bars.closes, cfg, warm, 4, bars.dates),
  });
}));

api.post('/ai/strategy', U, wrap(async (req, res) => {
  if (!auth.rateLimit('ai:' + req.user.id, 20, 3600e3)) throw new Error('AI builder limit reached for this hour');
  res.json(await buildStrategy(req.body.prompt));
}));

api.get('/strategies', U, async (req, res) => res.json(await all('SELECT * FROM strategies WHERE user_id = ? ORDER BY id DESC', req.user.id)));
api.post('/strategies', U, wrap(async (req, res) => {
  const b = req.body;
  if (!b.name || !b.symbol || !b.entry) throw new Error('Name, symbol and entry rules are required');
  const r = await run('INSERT INTO strategies (user_id, name, symbol, entry, exit, sl, tp, ts, size, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    req.user.id, String(b.name).slice(0, 80), String(b.symbol).toUpperCase(), b.entry, b.exit || '', +b.sl || 0, +b.tp || 0, +b.ts || 0, +b.size || 100, now());
  res.json({ id: Number(r.lastInsertRowid) });
}));
api.delete('/strategies/:id', U, async (req, res) => { await run('DELETE FROM strategies WHERE id = ? AND user_id = ?', +req.params.id, req.user.id); res.json({ ok: true }); });
api.post('/strategies/:id/deploy', U, wrap(async (req, res) => {
  const target = req.body.account === 'alpaca' ? 'alpaca' : req.body.account === 'paper' ? 'paper' : null;
  if (target === 'alpaca' && !PAID.includes(req.user.plan) && req.user.role !== 'admin') throw new Error('Live bots need the Pro plan');
  if (target === 'alpaca' && !(await getCred(req.user.id, 'alpaca'))) throw new Error('Connect Alpaca first');
  await run('UPDATE strategies SET deployed = ?, last_run = NULL WHERE id = ? AND user_id = ?', target, +req.params.id, req.user.id);
  await audit(req.user.id, target ? 'bot_deployed' : 'bot_stopped', { id: +req.params.id, target }, req.ip);
  res.json({ ok: true });
}));

api.get('/account', U, wrap(async (req, res) => {
  const a = acct(req), s = a === 'paper' ? await snapshotEquity(req.user.id) : await accountSummary(req.user.id, a);
  res.json({ ...s, history: await portfolioHistory(req.user.id, a).catch(() => []) });
}));
api.get('/orders', U, wrap(async (req, res) => res.json(await listOrders(req.user.id, acct(req)))));
api.post('/orders', U, wrap(async (req, res) => {
  const a = acct(req);
  if (a === 'alpaca' && !PAID.includes(req.user.plan) && req.user.role !== 'admin') throw new Error('Live trading needs the Pro plan');
  const r = await placeOrder(req.user.id, a, req.body, 'web');
  await audit(req.user.id, 'order', { ...r }, req.ip);
  res.json(r);
}));
api.get('/quote/:symbol', U, wrap(async (req, res) => res.json({ symbol: req.params.symbol.toUpperCase(), price: await lastPrice(req.params.symbol, req.user.id) })));
api.post('/paper/reset', U, async (req, res) => {
  await run("DELETE FROM positions WHERE user_id = ? AND account = 'paper'", req.user.id);
  await run("DELETE FROM fills WHERE user_id = ? AND account = 'paper'", req.user.id);
  await run("DELETE FROM equity_history WHERE user_id = ? AND account = 'paper'", req.user.id);
  await run('UPDATE paper_accounts SET cash = 100000, start_cash = 100000 WHERE user_id = ?', req.user.id);
  await run("UPDATE fee_state SET high_water = 100000, net_contrib = 100000 WHERE user_id = ? AND account = 'paper'", req.user.id);
  res.json({ ok: true });
});

api.get('/schedule', U, async (req, res) => res.json(await all('SELECT * FROM scheduled_orders WHERE user_id = ? ORDER BY active DESC, next_run', req.user.id)));
api.post('/schedule', U, needPlan, wrap(async (req, res) => {
  const b = req.body, at = Date.parse(b.at);
  if (!(at > now() - 60e3)) throw new Error('Pick a time in the future');
  if (!['once', 'daily', 'weekly', 'monthly'].includes(b.repeat)) throw new Error('Bad repeat');
  if (!(+b.qty > 0) && !(+b.notional > 0)) throw new Error('Give a quantity or dollar amount');
  const r = await run('INSERT INTO scheduled_orders (user_id, account, symbol, side, qty, notional, repeat, next_run, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    req.user.id, acct(req), String(b.symbol).toUpperCase(), b.side === 'sell' ? 'sell' : 'buy', +b.qty || null, +b.notional || null, b.repeat, at, now());
  res.json({ id: Number(r.lastInsertRowid) });
}));
api.delete('/schedule/:id', U, async (req, res) => { await run('UPDATE scheduled_orders SET active = 0 WHERE id = ? AND user_id = ?', +req.params.id, req.user.id); res.json({ ok: true }); });

api.get('/alerts', U, async (req, res) => res.json(await all('SELECT * FROM alerts WHERE user_id = ? ORDER BY id DESC', req.user.id)));
api.post('/alerts', U, wrap(async (req, res) => {
  const { symbol, op, price } = req.body;
  if (!['above', 'below'].includes(op) || !(+price > 0)) throw new Error('Bad alert');
  await run('INSERT INTO alerts (user_id, symbol, op, price, created_at) VALUES (?,?,?,?,?)', req.user.id, String(symbol).toUpperCase(), op, +price, now());
  res.json({ ok: true });
}));
api.delete('/alerts/:id', U, async (req, res) => { await run('DELETE FROM alerts WHERE id = ? AND user_id = ?', +req.params.id, req.user.id); res.json({ ok: true }); });

// --- integrations: Alpaca + QuantConnect keys are encrypted at rest ---
api.get('/integrations', U, async (req, res) => {
  const a = await getCred(req.user.id, 'alpaca'), q = await getCred(req.user.id, 'quantconnect');
  res.json({ alpaca: a ? { connected: true, live: !!a.live, keyHint: a.k.slice(0, 4) + '…' } : { connected: false }, quantconnect: q ? { connected: true, userId: q.userId } : { connected: false } });
});
api.post('/integrations/alpaca', U, wrap(async (req, res) => {
  const { keyId, secret, live } = req.body;
  if (!keyId || !secret) throw new Error('Key id and secret are required');
  const c = { k: String(keyId).trim(), s: String(secret).trim(), live: !!live };
  const r = await fetch((c.live ? 'https://api.alpaca.markets' : 'https://paper-api.alpaca.markets') + '/v2/account', { headers: { 'APCA-API-KEY-ID': c.k, 'APCA-API-SECRET-KEY': c.s } });
  if (!r.ok) throw new Error('Alpaca rejected these keys (' + r.status + ')');
  const a = await r.json();
  await run('INSERT INTO credentials (user_id, provider, blob) VALUES (?,?,?) ON CONFLICT DO UPDATE SET blob = excluded.blob', req.user.id, 'alpaca', encrypt(c));
  if (!(await one("SELECT 1 FROM fee_state WHERE user_id = ? AND account = 'alpaca'", req.user.id))) await adjustForCashflow(req.user.id, 'alpaca', +a.equity);
  await audit(req.user.id, 'alpaca_connected', { live: c.live }, req.ip);
  res.json({ ok: true, equity: +a.equity });
}));
api.post('/integrations/quantconnect', U, wrap(async (req, res) => {
  const c = { userId: String(req.body.userId).trim(), token: String(req.body.token).trim() };
  await QC.qc(c, '/authenticate');
  await run('INSERT INTO credentials (user_id, provider, blob) VALUES (?,?,?) ON CONFLICT DO UPDATE SET blob = excluded.blob', req.user.id, 'quantconnect', encrypt(c));
  res.json({ ok: true });
}));
api.delete('/integrations/:p', U, async (req, res) => { await run('DELETE FROM credentials WHERE user_id = ? AND provider = ?', req.user.id, req.params.p); res.json({ ok: true }); });

const qcCred = async req => { const c = await getCred(req.user.id, 'quantconnect'); if (!c) throw new Error('Connect QuantConnect in Settings first'); return c; };
api.get('/qc/templates', U, async (req, res) => res.json(Object.keys(QC.TEMPLATES)));
api.get('/qc/projects', U, wrap(async (req, res) => res.json(await QC.listProjects(await qcCred(req)))));
api.post('/qc/projects', U, needPlan, wrap(async (req, res) => {
  const code = QC.TEMPLATES[req.body.template] || req.body.code;
  if (!code) throw new Error('Pick a template or paste code');
  res.json({ id: await QC.createProject(await qcCred(req), String(req.body.name || req.body.template).slice(0, 60), code) });
}));
api.post('/qc/projects/:id/backtest', U, needPlan, wrap(async (req, res) => res.json({ backtestId: await QC.startBacktest(await qcCred(req), +req.params.id, req.body.name) })));
api.get('/qc/projects/:id/backtests', U, wrap(async (req, res) => res.json(await QC.listBacktests(await qcCred(req), +req.params.id))));
api.get('/qc/projects/:id/backtests/:bt', U, wrap(async (req, res) => res.json(await QC.readBacktest(await qcCred(req), +req.params.id, req.params.bt))));
api.get('/qc/live', U, wrap(async (req, res) => res.json(await QC.listLive(await qcCred(req)))));

// --- phone + PIN for SMS / hotline ---
api.post('/phone', U, wrap(async (req, res) => {
  const phone = String(req.body.phone || '').replace(/[^\d+]/g, '');
  if (!/^\+\d{10,15}$/.test(phone)) throw new Error('Use international format, e.g. +17185551234');
  if (await one('SELECT id FROM users WHERE phone = ? AND id != ?', phone, req.user.id)) throw new Error('Number already linked to another account');
  if (!auth.rateLimit('phone:' + req.user.id, 5, 3600e3)) throw new Error('Too many codes requested');
  const code = String(Math.floor(100000 + Math.random() * 900000));
  await run('UPDATE users SET phone = ?, phone_verified = 0, phone_code = ? WHERE id = ?', phone, hashSecret(code), req.user.id);
  const sent = await N.sendSms(phone, `QuantPocket code: ${code}`);
  res.json({ ok: true, devCode: sent.simulated && process.env.NODE_ENV !== 'production' ? code : undefined });
}));
api.post('/phone/verify', U, wrap(async (req, res) => {
  if (!verifySecret(String(req.body.code || ''), req.user.phone_code)) throw new Error('Wrong code');
  await run('UPDATE users SET phone_verified = 1, phone_code = NULL WHERE id = ?', req.user.id);
  await audit(req.user.id, 'phone_verified', null, req.ip);
  res.json({ ok: true });
}));
api.post('/pin', U, wrap(async (req, res) => {
  if (!verifySecret(String(req.body.password || ''), req.user.pass_hash)) throw new Error('Wrong password');
  if (!/^\d{4,8}$/.test(String(req.body.pin))) throw new Error('PIN must be 4-8 digits');
  await run('UPDATE users SET pin_hash = ? WHERE id = ?', hashSecret(String(req.body.pin)), req.user.id);
  res.json({ ok: true });
}));
api.post('/command', U, wrap(async (req, res) => res.json({ reply: await handleCommand(req.user, req.body.text) })));
api.get('/command/help', U, async (req, res) => res.json({ help: HELP }));

// --- billing, funding, fees ---
api.post('/billing/checkout', U, wrap(async (req, res) => {
  if (!(req.body.plan in PLANS) || req.body.plan === 'free') throw new Error('Pick a paid plan');
  if (!N.stripeEnabled()) throw new Error('Payments are not configured (STRIPE_SECRET_KEY)');
  const s = await N.checkoutSubscription({ plan: req.body.plan, email: req.user.email, userId: req.user.id, baseUrl: PUBLIC_URL });
  res.json({ url: s.url });
}));
api.post('/funding/deposit', U, wrap(async (req, res) => {
  const amount = +req.body.amount, a = acct(req);
  if (!(amount >= 10 && amount <= 10000)) throw new Error('Deposits are $10 - $10,000');
  if (a === 'paper') {
    await run('UPDATE paper_accounts SET cash = cash + ? WHERE user_id = ?', amount, req.user.id);
    await adjustForCashflow(req.user.id, 'paper', amount);
    await run('INSERT INTO ledger (user_id, kind, amount, status, memo, at) VALUES (?,?,?,?,?,?)', req.user.id, 'deposit', amount, 'simulated', 'Paper deposit', now());
    return res.json({ ok: true, simulated: true });
  }
  if (!N.stripeEnabled()) throw new Error('Card payments are not configured (STRIPE_SECRET_KEY)');
  const l = await run('INSERT INTO ledger (user_id, kind, amount, status, memo, at) VALUES (?,?,?,?,?,?)', req.user.id, 'deposit', amount, 'pending', 'Debit card deposit', now());
  const s = await N.checkoutDeposit({ amount, email: req.user.email, userId: req.user.id, ledgerId: Number(l.lastInsertRowid), baseUrl: PUBLIC_URL });
  res.json({ url: s.url });
}));
api.get('/ledger', U, async (req, res) => res.json(await all('SELECT * FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT 100', req.user.id)));
api.get('/fees', U, wrap(async (req, res) => {
  const rows = await all('SELECT * FROM fee_state WHERE user_id = ?', req.user.id);
  const plan = PLANS[req.user.plan];
  res.json({ plan: req.user.plan, rate: plan.perfFee, monthly: plan.monthly, accounts: rows });
}));

// --- tax ---
api.get('/tax', U, wrap(async (req, res) => {
  const a = acct(req), year = +req.query.year || new Date().getUTCFullYear();
  const fills = await all('SELECT * FROM fills WHERE user_id = ? AND account = ?', req.user.id, a);
  const s = taxSummary(fills, { year, bracket: req.user.tax_bracket, stateRate: req.user.state_tax });
  const pos = await accountSummary(req.user.id, a).then(x => x.positions).catch(() => []);
  if (req.query.format === 'csv') return res.type('text/csv').attachment(`form8949-${a}-${year}.csv`).send(form8949Csv(s.rows));
  res.json({ ...s, harvest: harvestCandidates(pos) });
}));
api.post('/tax/settings', U, wrap(async (req, res) => {
  const b = +req.body.bracket, st = +req.body.stateTax;
  if (!(b >= 0 && b <= 0.5 && st >= 0 && st <= 0.15)) throw new Error('Out of range');
  await run('UPDATE users SET tax_bracket = ?, state_tax = ? WHERE id = ?', b, st, req.user.id);
  res.json({ ok: true });
}));

// --- admin (platform owner) ---
api.get('/admin/summary', U, auth.requireAdmin, async (req, res) => res.json({
  ...(await revenueSummary()),
  pendingTransfers: await all("SELECT l.*, u.email FROM ledger l JOIN users u ON u.id = l.user_id WHERE l.kind = 'deposit' AND l.status = 'received' ORDER BY l.id DESC"),
  feesDue: await all("SELECT l.*, u.email FROM ledger l JOIN users u ON u.id = l.user_id WHERE l.kind = 'performance_fee' AND l.status = 'due' ORDER BY l.id DESC"),
  users: await all('SELECT id, email, plan, role, totp_enabled, phone_verified, created_at FROM users ORDER BY id DESC LIMIT 200'),
}));
api.get('/admin/messages', U, auth.requireAdmin, async (req, res) => res.json(await all('SELECT * FROM messages ORDER BY id DESC LIMIT 100')));
api.post('/admin/messages/:id', U, auth.requireAdmin, async (req, res) => { await run("UPDATE messages SET status = 'closed' WHERE id = ?", +req.params.id); res.json({ ok: true }); });
api.post('/admin/assess-fees', U, auth.requireAdmin, wrap(async (req, res) => res.json(await assessAllFees())));
api.post('/admin/ledger/:id', U, auth.requireAdmin, wrap(async (req, res) => {
  if (!['transferred', 'collected', 'waived'].includes(req.body.status)) throw new Error('Bad status');
  await run('UPDATE ledger SET status = ? WHERE id = ?', req.body.status, +req.params.id);
  await audit(req.user.id, 'ledger_update', { id: +req.params.id, status: req.body.status }, req.ip);
  res.json({ ok: true });
}));

api.use((req, res) => res.status(404).json({ error: 'Not found' }));
api.use((err, req, res, _next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  console.error(err);
  res.status(err.status || 400).json({ error: err.expose === false ? 'Something went wrong' : err.message });
});
app.use('/api', api);
const pub = path.join(here, 'public');
// Marketing pages get absolute social-preview image URLs (crawlers ignore relative ones).
const htmlCache = new Map();
const page = file => async (req, res) => {
  if (!htmlCache.has(file) || process.env.NODE_ENV !== 'production')
    htmlCache.set(file, (await fs.readFile(path.join(pub, file), 'utf8')).replace('content="og.png"', `content="${PUBLIC_URL}/og.png"`));
  res.type('html').send(htmlCache.get(file));
};
app.get('/app', async (req, res) => res.sendFile(path.join(pub, 'app.html')));
app.get(['/', '/index.html', '/pricing'], page('index.html'));
for (const p of ['terms', 'privacy', 'risk', 'contact']) app.get(['/' + p, `/${p}.html`], page(p + '.html'));
app.use(express.static(pub, { index: 'index.html', maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0, extensions: ['html'] }));
app.use(async (req, res) => res.status(404).sendFile(path.join(pub, '404.html')));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = +process.env.PORT || 3000;
  const server = app.listen(port, () => console.log(`QuantPocket on http://localhost:${port}`));
  const timer = startScheduler();
  const stop = () => { clearInterval(timer); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 8000).unref(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
