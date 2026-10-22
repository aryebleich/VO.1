// Background jobs: scheduled orders, auto-trading bots, price alerts, equity snapshots, monthly fees.
import { one, all, run, now } from './db.js';
import { placeOrder, getBars, lastPrice, snapshotEquity, accountSummary, getCred } from './brokers.js';
import { latestSignal } from './engine.js';
import { sendSms } from './notify.js';
import { assessFee } from './fees.js';

const DAY = 86400e3;

// Next run time, skipping weekends so orders land on trading days.
export function nextRunAfter(t, repeat) {
  const d = new Date(t);
  if (repeat === 'daily') d.setUTCDate(d.getUTCDate() + 1);
  else if (repeat === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
  else if (repeat === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1);
  else return null;
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.getTime();
}

function nyTime(t = now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' })
    .formatToParts(new Date(t)).map(x => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, minutes: (+p.hour % 24) * 60 + +p.minute, weekday: p.weekday };
}
export const marketOpen = (t = now()) => { const n = nyTime(t); return !['Sat', 'Sun'].includes(n.weekday) && n.minutes >= 570 && n.minutes < 960; };

async function notify(userId, msg) {
  const u = await one('SELECT phone, phone_verified FROM users WHERE id = ?', userId);
  if (u?.phone && u.phone_verified) await sendSms(u.phone, msg).catch(e => console.warn('sms', e.message));
}

export async function runScheduledOrders(t = now()) {
  const due = await all('SELECT * FROM scheduled_orders WHERE active = 1 AND next_run <= ?', t);
  for (const o of due) {
    let result;
    try {
      const r = await placeOrder(o.user_id, o.account, { symbol: o.symbol, side: o.side, qty: o.qty, notional: o.notional }, 'schedule');
      result = `${r.status}${r.price ? ' @ ' + r.price.toFixed(2) : ''}`;
    } catch (e) { result = 'error: ' + e.message; }
    const next = nextRunAfter(o.next_run, o.repeat);
    await run('UPDATE scheduled_orders SET last_result = ?, next_run = COALESCE(?, next_run), active = ? WHERE id = ?', result, next, next ? 1 : 0, o.id);
    notify(o.user_id, `Scheduled ${o.side} ${o.symbol}: ${result}`);
  }
  return due.length;
}

// Bots evaluate their rules once per trading day, shortly before the close (15:45 New York).
export async function runBots(t = now()) {
  const n = nyTime(t);
  if (['Sat', 'Sun'].includes(n.weekday) || n.minutes < 930 || n.minutes >= 960) return 0;
  const bots = await all('SELECT * FROM strategies WHERE deployed IS NOT NULL AND (last_run IS NULL OR last_run != ?)', n.day);
  for (const b of bots) {
    let action = 'hold';
    try {
      const bars = await getBars(b.symbol, new Date(t - 3 * 365 * DAY).toISOString().slice(0, 10), b.user_id);
      const sig = latestSignal(bars.closes, b);
      const s = await accountSummary(b.user_id, b.deployed);
      const pos = s.positions.find(p => p.symbol === b.symbol);
      if (pos && sig.exit) { await placeOrder(b.user_id, b.deployed, { symbol: b.symbol, side: 'sell', qty: pos.qty }, 'bot'); action = 'sold'; }
      else if (!pos && sig.enter) {
        const notional = +(s.cash * Math.min(b.size, 100) / 100 * 0.98).toFixed(2);
        if (notional >= 1) { await placeOrder(b.user_id, b.deployed, { symbol: b.symbol, side: 'buy', notional }, 'bot'); action = `bought $${notional}`; }
      }
    } catch (e) { action = 'error: ' + e.message; }
    await run('UPDATE strategies SET last_run = ?, last_action = ? WHERE id = ?', n.day, action, b.id);
    if (action !== 'hold') notify(b.user_id, `Bot "${b.name}" ${b.symbol}: ${action}`);
  }
  return bots.length;
}

export async function runAlerts() {
  const alerts = await all('SELECT * FROM alerts WHERE active = 1');
  for (const a of alerts) {
    const px = await lastPrice(a.symbol, a.user_id).catch(() => null);
    if (px == null) continue;
    if ((a.op === 'above' && px >= a.price) || (a.op === 'below' && px <= a.price)) {
      await run('UPDATE alerts SET active = 0 WHERE id = ?', a.id);
      notify(a.user_id, `Alert: ${a.symbol} is ${px.toFixed(2)} (${a.op} ${a.price})`);
    }
  }
}

export async function snapshotAll() {
  for (const u of await all('SELECT id FROM users')) await snapshotEquity(u.id).catch(() => {});
}

// Monthly: assess performance fees on every account with a high-water mark.
export async function assessAllFees() {
  const out = [];
  for (const s of await all('SELECT user_id, account FROM fee_state')) {
    try {
      if (s.account === 'alpaca' && !(await getCred(s.user_id, 'alpaca'))) continue;
      const sum = await accountSummary(s.user_id, s.account);
      out.push({ userId: s.user_id, account: s.account, ...(await assessFee(s.user_id, s.account, sum.equity)) });
    } catch (e) { out.push({ userId: s.user_id, account: s.account, error: e.message }); }
  }
  return out;
}

let last = { alerts: 0, snap: '', fees: '' };
export function startScheduler() {
  const tick = async () => {
    try {
      await runScheduledOrders();
      await runBots();
      const t = now(), n = nyTime(t);
      if (marketOpen(t) && t - last.alerts > 5 * 60e3) { last.alerts = t; await runAlerts(); }
      if (n.minutes >= 965 && last.snap !== n.day) { last.snap = n.day; await snapshotAll(); }
      const month = n.day.slice(0, 7);
      if (n.day.endsWith('-01') && last.fees !== month) { last.fees = month; await assessAllFees(); }
    } catch (e) { console.error('scheduler', e); }
  };
  return setInterval(tick, 30e3);
}
