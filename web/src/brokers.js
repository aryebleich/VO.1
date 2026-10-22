// Market data + broker adapters: Alpaca (paper/live) and the built-in paper simulator.
import { one, all, run, now, tx } from './db.js';
import { decrypt } from './crypto.js';
import { rng } from './engine.js';

export const DATA = 'https://data.alpaca.markets/v2';
const TRADE = { paper: 'https://paper-api.alpaca.markets/v2', live: 'https://api.alpaca.markets/v2' };

export async function getCred(userId, provider) {
  const r = await one('SELECT blob FROM credentials WHERE user_id = ? AND provider = ?', userId, provider);
  return r ? decrypt(r.blob) : null;
}
// Fall back to a platform-wide market-data key so demo users can backtest real history.
async function dataCred(userId) {
  const c = userId && await getCred(userId, 'alpaca');
  if (c) return c;
  if (process.env.ALPACA_KEY_ID && process.env.ALPACA_SECRET) return { k: process.env.ALPACA_KEY_ID, s: process.env.ALPACA_SECRET };
  return null;
}
const hdr = c => ({ 'APCA-API-KEY-ID': c.k, 'APCA-API-SECRET-KEY': c.s, 'Content-Type': 'application/json' });

// Seeded geometric Brownian motion with regime shifts; clearly labeled as synthetic in the UI.
export function syntheticBars(symbol, n = 2520) {
  const seed = [...symbol].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) >>> 0;
  const rand = rng(seed), gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
  const closes = [], dates = [];
  let px = 50 + (seed % 250), mu = 0.0004, vol = 0.015;
  const d = new Date(Date.UTC(2016, 0, 4));
  for (let i = 0; i < n; i++) {
    if (i % 250 === 0) { mu = 0.0004 + (rand() - 0.5) * 0.0016; vol = 0.008 + rand() * 0.02; }
    px *= Math.exp(mu - vol * vol / 2 + vol * gauss());
    closes.push(+px.toFixed(2));
    do d.setUTCDate(d.getUTCDate() + 1); while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
    dates.push(d.toISOString().slice(0, 10));
  }
  return { closes, dates, source: 'synthetic' };
}

const barCache = new Map();

// Free daily history (split/dividend adjusted) for users without an Alpaca key.
async function yahooBars(symbol, start) {
  if (process.env.FREE_DATA === 'off') return null;
  const from = Math.floor(Date.parse(start) / 1000), to = Math.floor(Date.now() / 1000);
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${from}&period2=${to}&interval=1d&events=split,div`,
    { headers: { 'User-Agent': 'Mozilla/5.0 QuantPocket' }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) return null;
  const res = (await r.json()).chart?.result?.[0];
  const ts = res?.timestamp || [], adj = res?.indicators?.adjclose?.[0]?.adjclose || res?.indicators?.quote?.[0]?.close || [];
  const closes = [], dates = [];
  ts.forEach((t, i) => { if (adj[i] != null) { closes.push(+adj[i].toFixed(4)); dates.push(new Date(t * 1000).toISOString().slice(0, 10)); } });
  return closes.length >= 260 ? { closes, dates, source: 'yahoo' } : null;
}
const quoteCache = new Map();
async function yahooQuote(symbol) {
  if (process.env.FREE_DATA === 'off') return null;
  const hit = quoteCache.get(symbol);
  if (hit && now() - hit.at < 15e3) return hit.p;
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol.toUpperCase())}?range=1d&interval=1m`,
    { headers: { 'User-Agent': 'Mozilla/5.0 QuantPocket' }, signal: AbortSignal.timeout(5000) });
  if (!r.ok) return null;
  const p = (await r.json()).chart?.result?.[0]?.meta?.regularMarketPrice;
  if (p) quoteCache.set(symbol, { at: now(), p });
  return p || null;
}

export async function getBars(symbol, start, userId) {
  symbol = symbol.toUpperCase();
  const key = symbol + start;
  const hit = barCache.get(key);
  if (hit && now() - hit.at < 3600e3) return hit.v;
  const c = await dataCred(userId);
  if (!c) {
    const v = await yahooBars(symbol, start).catch(() => null) || syntheticBars(symbol);
    barCache.set(key, { at: now(), v });
    return v;
  }
  const closes = [], dates = []; let tok = '';
  do {
    const r = await fetch(`${DATA}/stocks/${encodeURIComponent(symbol)}/bars?timeframe=1Day&start=${start}&limit=10000&adjustment=all&feed=iex${tok ? '&page_token=' + tok : ''}`, { headers: hdr(c) });
    if (!r.ok) throw new Error(`${symbol}: ${r.status} ${(await r.text()).slice(0, 120)}`);
    const d = await r.json();
    for (const b of d.bars || []) { closes.push(b.c); dates.push(b.t.slice(0, 10)); }
    tok = d.next_page_token || '';
  } while (tok);
  if (closes.length < 260) throw new Error(`${symbol}: only ${closes.length} daily bars available`);
  const v = { closes, dates, source: 'alpaca' };
  barCache.set(key, { at: now(), v });
  return v;
}

export async function lastPrice(symbol, userId) {
  const c = await dataCred(userId);
  if (!c) {
    const q = await yahooQuote(symbol).catch(() => null);
    if (q) return q;
    const b = await getBars(symbol, new Date(Date.now() - 400 * 86400e3).toISOString().slice(0, 10), null); return b.closes[b.closes.length - 1];
  }
  const r = await fetch(`${DATA}/stocks/${encodeURIComponent(symbol.toUpperCase())}/trades/latest?feed=iex`, { headers: hdr(c) });
  if (!r.ok) throw new Error(`Quote ${symbol}: ${r.status}`);
  return (await r.json()).trade.p;
}

async function alpaca(c, path, method = 'GET', body) {
  const r = await fetch(TRADE[c.live ? 'live' : 'paper'] + path, { method, headers: hdr(c), body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`Alpaca ${r.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : {};
}

// --- unified account interface; account is 'paper' (built-in sim) or 'alpaca' ---

export async function accountSummary(userId, account) {
  if (account === 'alpaca') {
    const c = await getCred(userId, 'alpaca'); if (!c) throw new Error('Connect Alpaca in Settings first');
    const [a, pos] = await Promise.all([alpaca(c, '/account'), alpaca(c, '/positions')]);
    return {
      account, live: !!c.live, cash: +a.cash, equity: +a.equity, buyingPower: +a.buying_power, lastEquity: +a.last_equity,
      positions: pos.map(p => ({ symbol: p.symbol, qty: +p.qty, avgPrice: +p.avg_entry_price, price: +p.current_price, value: +p.market_value, pnl: +p.unrealized_pl })),
    };
  }
  const acct = await one('SELECT * FROM paper_accounts WHERE user_id = ?', userId);
  const pos = await all("SELECT * FROM positions WHERE user_id = ? AND account = 'paper' AND qty != 0", userId);
  const priced = await Promise.all(pos.map(async p => {
    const price = await lastPrice(p.symbol, userId).catch(() => p.avg_price);
    return { symbol: p.symbol, qty: p.qty, avgPrice: p.avg_price, price, value: p.qty * price, pnl: (price - p.avg_price) * p.qty };
  }));
  const equity = acct.cash + priced.reduce((a, p) => a + p.value, 0);
  return { account, live: false, cash: acct.cash, equity, buyingPower: acct.cash, startCash: acct.start_cash, positions: priced };
}

// Records a fill and updates the average-cost position; used by both paper and broker paths.
export async function recordFill(userId, account, symbol, side, qty, price, source, brokerId = null) {
  await tx(async ({ one, run }) => {
    const p = await one('SELECT * FROM positions WHERE user_id = ? AND account = ? AND symbol = ?', userId, account, symbol);
    const cur = p?.qty || 0, avg = p?.avg_price || 0;
    const nq = side === 'buy' ? cur + qty : cur - qty;
    const navg = side === 'buy' ? (cur * avg + qty * price) / nq : avg;
    await run('INSERT INTO positions (user_id, account, symbol, qty, avg_price) VALUES (?,?,?,?,?) ON CONFLICT(user_id, account, symbol) DO UPDATE SET qty = excluded.qty, avg_price = excluded.avg_price',
      userId, account, symbol, +nq.toFixed(6), nq ? navg : 0);
    await run('INSERT INTO fills (user_id, account, symbol, side, qty, price, source, broker_order_id, at) VALUES (?,?,?,?,?,?,?,?,?)', userId, account, symbol, side, qty, price, source, brokerId, now());
    if (account === 'paper') await run('UPDATE paper_accounts SET cash = cash + ? WHERE user_id = ?', (side === 'buy' ? -1 : 1) * qty * price, userId);
  });
}

// order: { symbol, side, qty?, notional? }
export async function placeOrder(userId, account, order, source = 'manual') {
  const symbol = String(order.symbol || '').toUpperCase();
  const side = order.side === 'sell' ? 'sell' : 'buy';
  if (!/^[A-Z.]{1,10}$/.test(symbol)) throw new Error('Invalid symbol');
  if (!(+order.qty > 0) && !(+order.notional > 0)) throw new Error('Give a quantity or dollar amount');
  if (account === 'alpaca') {
    const c = await getCred(userId, 'alpaca'); if (!c) throw new Error('Connect Alpaca in Settings first');
    const body = { symbol, side, type: 'market', time_in_force: 'day', ...(+order.qty > 0 ? { qty: String(+order.qty) } : { notional: String(+order.notional) }) };
    const o = await alpaca(c, '/orders', 'POST', body);
    // Record the fill locally once Alpaca reports it so tax lots stay complete.
    setTimeout(() => syncAlpacaOrder(userId, c, o.id, source).catch(() => {}), 4000);
    return { id: o.id, status: o.status, symbol, side, broker: 'alpaca', live: !!c.live };
  }
  const price = await lastPrice(symbol, userId);
  let qty = +order.qty > 0 ? +order.qty : +(+order.notional / price).toFixed(6);
  const acct = await one('SELECT cash FROM paper_accounts WHERE user_id = ?', userId);
  if (side === 'buy' && qty * price > acct.cash + 1e-6) throw new Error(`Not enough paper cash ($${acct.cash.toFixed(2)})`);
  if (side === 'sell') {
    const p = await one("SELECT qty FROM positions WHERE user_id = ? AND account = 'paper' AND symbol = ?", userId, symbol);
    if (!p || p.qty < qty - 1e-9) throw new Error(`You hold ${p?.qty || 0} ${symbol}`);
  }
  await recordFill(userId, 'paper', symbol, side, qty, price, source);
  return { status: 'filled', symbol, side, qty, price, broker: 'paper' };
}

async function syncAlpacaOrder(userId, c, id, source) {
  const o = await alpaca(c, `/orders/${id}`);
  if (o.status !== 'filled') return;
  if (await one('SELECT id FROM fills WHERE broker_order_id = ?', id)) return;
  await recordFill(userId, 'alpaca', o.symbol, o.side, +o.filled_qty, +o.filled_avg_price, source, id);
}

export async function listOrders(userId, account) {
  if (account === 'alpaca') {
    const c = await getCred(userId, 'alpaca'); if (!c) throw new Error('Connect Alpaca in Settings first');
    return (await alpaca(c, '/orders?status=all&limit=50')).map(o => ({ id: o.id, symbol: o.symbol, side: o.side, qty: +o.qty || null, notional: +o.notional || null, status: o.status, price: +o.filled_avg_price || null, at: o.submitted_at }));
  }
  return (await all("SELECT id, symbol, side, qty, price, source, at FROM fills WHERE user_id = ? AND account = 'paper' ORDER BY id DESC LIMIT 50", userId)).map(f => ({ ...f, status: 'filled' }));
}

export async function portfolioHistory(userId, account) {
  if (account === 'alpaca') {
    const c = await getCred(userId, 'alpaca'); if (!c) throw new Error('Connect Alpaca in Settings first');
    const h = await alpaca(c, '/account/portfolio/history?period=1A&timeframe=1D');
    return h.timestamp.map((t, i) => ({ day: new Date(t * 1000).toISOString().slice(0, 10), equity: h.equity[i] })).filter(x => x.equity != null);
  }
  return await all("SELECT day, equity FROM equity_history WHERE user_id = ? AND account = 'paper' ORDER BY day", userId);
}

export async function snapshotEquity(userId) {
  const s = await accountSummary(userId, 'paper');
  await run("INSERT INTO equity_history (user_id, account, day, equity) VALUES (?, 'paper', ?, ?) ON CONFLICT DO UPDATE SET equity = excluded.equity", userId, new Date().toISOString().slice(0, 10), s.equity);
  return s;
}
