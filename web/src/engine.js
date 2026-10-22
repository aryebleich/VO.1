// Strategy engine shared with the mobile app (App.js): indicators, rule DSL, backtest, plus
// risk metrics, Monte Carlo return projection and walk-forward validation.
const sma = (p, n) => { const o = Array(p.length).fill(null); let s = 0; for (let i = 0; i < p.length; i++) { s += p[i]; if (i >= n) s -= p[i - n]; if (i >= n - 1) o[i] = s / n; } return o; };
const emaRaw = (p, n) => { const k = 2 / (n + 1), o = [p[0]]; for (let i = 1; i < p.length; i++) o.push(p[i] * k + o[i - 1] * (1 - k)); return o; };
const mask = (a, n) => a.map((v, i) => (i < n ? null : v));
const rsi = (p, n) => { const o = Array(p.length).fill(null); let g = 0, l = 0; for (let i = 1; i < p.length; i++) { const d = p[i] - p[i - 1], u = Math.max(d, 0), w = Math.max(-d, 0); if (i <= n) { g += u / n; l += w / n; } else { g = (g * (n - 1) + u) / n; l = (l * (n - 1) + w) / n; } if (i >= n) o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } return o; };
const bb = (p, n, k, sg) => { const m = sma(p, n); return p.map((_, i) => { if (m[i] == null) return null; let v = 0; for (let j = i - n + 1; j <= i; j++) v += (p[j] - m[i]) ** 2; return m[i] + sg * k * Math.sqrt(v / n); }); };
const macdLine = (p, f, s) => { const a = emaRaw(p, f), b = emaRaw(p, s); return a.map((v, i) => v - b[i]); };

export function operand(str, p) {
  const t = str.trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) return Array(p.length).fill(parseFloat(t));
  const m = t.match(/^([A-Z]+)(?:\(([^)]*)\))?$/);
  if (!m) throw new Error('Bad operand: ' + str);
  const a = (m[2] || '').split(',').filter(Boolean).map(Number), n = a[0];
  switch (m[1]) {
    case 'CLOSE': return p;
    case 'SMA': return sma(p, n);
    case 'EMA': return mask(emaRaw(p, n), n - 1);
    case 'RSI': return rsi(p, n);
    case 'BBU': return bb(p, n, a[1] ?? 2, 1);
    case 'BBL': return bb(p, n, a[1] ?? 2, -1);
    case 'HIGH': return p.map((_, i) => (i < n ? null : Math.max(...p.slice(i - n, i))));
    case 'LOW': return p.map((_, i) => (i < n ? null : Math.min(...p.slice(i - n, i))));
    case 'ROC': return p.map((x, i) => (i < n ? null : (x / p[i - n] - 1) * 100));
    case 'MACD': return mask(macdLine(p, a[0], a[1]), a[1]);
    case 'MACDSIG': return mask(emaRaw(macdLine(p, a[0], a[1]), a[2]), a[1] + a[2]);
    default: throw new Error('Unknown indicator: ' + m[1]);
  }
}
export const RULE = /^(.+?)\s*(>=|<=|>|<|CROSSES_ABOVE|CROSSES_BELOW)\s*(.+)$/;
export function compile(txt, p) {
  return txt.split('\n').map(s => s.trim()).filter(Boolean).map(line => {
    const m = line.toUpperCase().match(RULE);
    if (!m) throw new Error('Bad rule: ' + line);
    const A = operand(m[1], p), B = operand(m[3], p), op = m[2];
    return i => {
      const x = A[i], y = B[i];
      if (x == null || y == null) return false;
      if (op === '>') return x > y;
      if (op === '<') return x < y;
      if (op === '>=') return x >= y;
      if (op === '<=') return x <= y;
      if (i < 1 || A[i - 1] == null || B[i - 1] == null) return false;
      return op === 'CROSSES_ABOVE' ? A[i - 1] <= B[i - 1] && x > y : A[i - 1] >= B[i - 1] && x < y;
    };
  });
}

export const PRESETS = {
  'SMA cross': { entry: 'SMA(20) crosses_above SMA(100)', exit: 'SMA(20) crosses_below SMA(100)' },
  'RSI dip in uptrend': { entry: 'RSI(14) < 30\nClose > SMA(200)', exit: 'RSI(14) > 60' },
  'Bollinger revert': { entry: 'Close < BBL(20,2)', exit: 'Close > SMA(20)' },
  'Breakout': { entry: 'Close > HIGH(55)', exit: 'Close < LOW(20)' },
  'MACD trend': { entry: 'MACD(12,26) crosses_above MACDSIG(12,26,9)\nClose > SMA(200)', exit: 'MACD(12,26) crosses_below MACDSIG(12,26,9)' },
  'Momentum 12m': { entry: 'ROC(252) > 0\nClose > SMA(50)', exit: 'ROC(252) < 0' },
};

export function metrics(eq, start = eq[0]) {
  const r = eq.slice(1).map((v, i) => v / eq[i] - 1);
  const n = r.length || 1, mu = r.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(r.reduce((a, b) => a + (b - mu) ** 2, 0) / n) || 1e-9;
  const dsd = Math.sqrt(r.reduce((a, b) => a + Math.min(b, 0) ** 2, 0) / n) || 1e-9;
  let peak = eq[0], dd = 0; eq.forEach(v => { peak = Math.max(peak, v); dd = Math.max(dd, (peak - v) / peak); });
  const years = Math.max(eq.length - 1, 1) / 252, end = eq[eq.length - 1];
  const cagr = (end / start) ** (1 / years) - 1;
  return {
    ret: (end / start - 1) * 100, cagr: cagr * 100, vol: sd * Math.sqrt(252) * 100, dd: dd * 100,
    sharpe: mu / sd * Math.sqrt(252), sortino: mu / dsd * Math.sqrt(252), calmar: dd ? cagr / dd : NaN,
  };
}

// Signals use bar i-1; trades fill at the close of bar i (no look-ahead). Stops are checked on closes.
export function backtest(p, cfg, from = 0, to = p.length, dates = []) {
  const en = compile(cfg.entry || '', p), ex = compile(cfg.exit || '', p);
  const cost = cfg.cost != null ? +cfg.cost / 100 : 0.0015;
  const sl = +cfg.sl || 0, tp = +cfg.tp || 0, ts = +cfg.ts || 0, size = Math.min(+cfg.size || 100, 100);
  const start = +cfg.capital || 1e4;
  let cash = start, sh = 0, ep = 0, pk = 0, entryAt = 0, inMkt = 0;
  const eq = [], bh = [], trades = [];
  from = Math.max(from, 1);
  for (let i = from; i < to; i++) {
    const px = p[i];
    if (sh > 0) {
      inMkt++;
      pk = Math.max(pk, px);
      const why = sl && px <= ep * (1 - sl / 100) ? 'stop loss' : tp && px >= ep * (1 + tp / 100) ? 'take profit'
        : ts && px <= pk * (1 - ts / 100) ? 'trailing stop' : ex.length && ex.some(r => r(i - 1)) ? 'exit rule' : null;
      if (why) {
        cash += sh * px * (1 - cost);
        trades.push({ entryDate: dates[entryAt] || entryAt, exitDate: dates[i] || i, entry: ep, exit: px, qty: sh, pnlPct: (px * (1 - cost) / (ep * (1 + cost)) - 1) * 100, reason: why });
        sh = 0;
      }
    } else if (en.length && en.every(r => r(i - 1))) {
      const amt = cash * size / 100; sh = amt * (1 - cost) / px; cash -= amt; ep = px; pk = px; entryAt = i;
    }
    eq.push(cash + sh * px); bh.push(start * px / p[from]);
  }
  const m = metrics([start, ...eq], start);
  const wins = trades.filter(t => t.pnlPct > 0);
  const gw = wins.reduce((a, t) => a + t.pnlPct, 0), gl = trades.filter(t => t.pnlPct <= 0).reduce((a, t) => a - t.pnlPct, 0);
  return {
    eq, bh, holding: sh > 0, trades, dates: dates.slice(from, to),
    m: { ...m, bh: (bh[bh.length - 1] / start - 1) * 100, trades: trades.length, win: trades.length ? wins.length / trades.length * 100 : NaN,
      profitFactor: gl ? gw / gl : NaN, exposure: eq.length ? inMkt / eq.length * 100 : 0 },
  };
}

// Deterministic PRNG so projections are reproducible for a given seed.
export function rng(seed = 42) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Block-bootstrap the strategy's daily returns into many simulated years and report the
// distribution of one-year outcomes. This is an estimate from history, not a promise.
export function projectAnnual(eq, { sims = 2000, days = 252, block = 10, seed = 7 } = {}) {
  const r = eq.slice(1).map((v, i) => v / eq[i] - 1);
  if (r.length < block * 3) return null;
  const rand = rng(seed), out = [];
  for (let s = 0; s < sims; s++) {
    let g = 1;
    for (let d = 0; d < days;) {
      const st = Math.floor(rand() * (r.length - block));
      for (let k = 0; k < block && d < days; k++, d++) g *= 1 + r[st + k];
    }
    out.push((g - 1) * 100);
  }
  out.sort((a, b) => a - b);
  const q = x => out[Math.min(out.length - 1, Math.floor(x * out.length))];
  return { p5: q(0.05), p25: q(0.25), median: q(0.5), p75: q(0.75), p95: q(0.95), probLoss: out.filter(x => x < 0).length / out.length * 100, mean: out.reduce((a, b) => a + b, 0) / out.length };
}

// Split history into rolling train/test windows; only the test (out-of-sample) segments count.
export function walkForward(p, cfg, warmup, folds = 4, dates = []) {
  const span = p.length - warmup, seg = Math.floor(span / (folds + 1));
  if (seg < 60) return null;
  const rows = [];
  for (let f = 1; f <= folds; f++) {
    const a = warmup + f * seg, b = Math.min(p.length, a + seg);
    const r = backtest(p, cfg, a, b, dates);
    rows.push({ fold: f, from: dates[a] || a, to: dates[b - 1] || b - 1, ret: r.m.ret, bh: r.m.bh, dd: r.m.dd, trades: r.m.trades });
  }
  return { folds: rows, beatRate: rows.filter(x => x.ret > x.bh).length / rows.length * 100 };
}

// Grid search over numbers wrapped in braces, e.g. "SMA({10,20,50}) crosses_above SMA({100,200})".
export function optimize(p, cfg, from, dates = [], maxRuns = 200) {
  const re = /\{([\d.,\s]+)\}/g, slots = [];
  const collect = s => s.replace(re, (_, g) => { slots.push(g.split(',').map(x => x.trim()).filter(Boolean)); return `\u0000${slots.length - 1}\u0000`; });
  const entryT = collect(cfg.entry || ''), exitT = collect(cfg.exit || '');
  if (!slots.length) return null;
  const combos = slots.reduce((acc, vals) => acc.flatMap(c => vals.map(v => [...c, v])), [[]]).slice(0, maxRuns);
  const fill = (t, c) => t.replace(/\u0000(\d+)\u0000/g, (_, i) => c[+i]);
  const half = from + Math.floor((p.length - from) / 2);
  const rows = combos.map(c => {
    const conf = { ...cfg, entry: fill(entryT, c), exit: fill(exitT, c) };
    const ins = backtest(p, conf, from, half, dates), oos = backtest(p, conf, half, p.length, dates);
    return { params: c, entry: conf.entry, exit: conf.exit, inSharpe: ins.m.sharpe, inRet: ins.m.ret, oosSharpe: oos.m.sharpe, oosRet: oos.m.ret };
  });
  rows.sort((a, b) => b.inSharpe - a.inSharpe);
  return { runs: rows.length, best: rows.slice(0, 15), note: 'Ranked by in-sample Sharpe (first half). Check that out-of-sample (second half) holds up before trusting a setting.' };
}

// Bars needed before the first tradable bar: the largest lookback referenced in the rules.
export function warmupFor(cfg) {
  const nums = `${cfg.entry || ''}\n${cfg.exit || ''}`.match(/\d+/g) || [];
  return Math.min(Math.max(1, ...nums.map(Number).filter(n => n < 1000)) + 1, 400);
}

// Evaluate the latest signal (used by auto-trading bots and SMS "SIGNAL" command).
export function latestSignal(p, cfg) {
  const en = compile(cfg.entry || '', p), ex = compile(cfg.exit || '', p), i = p.length; // signal on last closed bar
  return { enter: en.length > 0 && en.every(r => r(i - 1)), exit: ex.length > 0 && ex.some(r => r(i - 1)) };
}
