// Marketing pages: app links, live demo backtest and the contact form.
// window.QP.api is '' when served by the app itself, or the app's URL on the GitHub Pages copy.
import { backtest, projectAnnual, warmupFor, PRESETS, rng } from './engine.js';

const API = (window.QP && window.QP.api) ?? '';
const standalone = window.QP?.standalone && !API;
const $ = s => document.querySelector(s);

for (const a of document.querySelectorAll('a[data-app]')) a.href = standalone ? 'contact.html' : `${API || '.'}/app${a.dataset.app}`;

async function post(path, body) {
  const r = await fetch(API + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'qp' }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Request failed');
  return d;
}
const pct = x => (isFinite(x) ? (x > 0 ? '+' : '') + x.toFixed(1) + '%' : '-');
const cls = x => (x > 0 ? 'pos' : x < 0 ? 'neg' : '');

function draw(canvas, series, base, compare) {
  const dpr = devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const g = canvas.getContext('2d'); g.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement), C = k => css.getPropertyValue(k).trim();
  const vals = [...series, ...compare, base];
  let lo = Math.min(...vals), hi = Math.max(...vals); if (hi === lo) hi += 1;
  const X = i => 6 + (i / (series.length - 1)) * (w - 12), Y = v => 6 + (1 - (v - lo) / (hi - lo)) * (h - 12), yb = Y(base);
  g.strokeStyle = C('--mu'); g.globalAlpha = 0.6; g.beginPath(); compare.forEach((v, i) => (i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v)))); g.stroke(); g.globalAlpha = 1;
  const path = () => { g.beginPath(); series.forEach((v, i) => (i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v)))); };
  for (const [col, y0, y1] of [[C('--gr'), 0, yb], [C('--rd'), yb, h]]) {
    g.save(); g.beginPath(); g.rect(0, y0, w, y1 - y0); g.clip();
    path(); g.lineTo(X(series.length - 1), yb); g.lineTo(X(0), yb); g.closePath(); g.globalAlpha = 0.14; g.fillStyle = col; g.fill(); g.globalAlpha = 1;
    path(); g.lineWidth = 2; g.strokeStyle = col; g.stroke(); g.restore();
  }
}

// Offline fallback: seeded random-walk prices so the demo always works.
function synthetic(symbol) {
  const seed = [...symbol].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) >>> 0, rand = rng(seed);
  const p = []; let px = 100, mu = 0.0004, vol = 0.012;
  for (let i = 0; i < 2600; i++) {
    if (i % 250 === 0) { mu = 0.0004 + (rand() - 0.5) * 0.0016; vol = 0.008 + rand() * 0.015; }
    px *= Math.exp(mu + vol * Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand()));
    p.push(px);
  }
  return p;
}

async function runDemo(e) {
  e?.preventDefault();
  const f = new FormData($('#demoForm')), symbol = String(f.get('symbol') || 'SPY').toUpperCase(), preset = f.get('preset');
  const btn = $('#demoForm button'); btn.disabled = true; $('#demoErr').textContent = '';
  let r;
  try {
    if (standalone) throw new Error('offline');
    r = await post('/api/public/backtest', { symbol, preset });
  } catch (err) {
    if (err.message !== 'offline' && !/fetch|network|Failed/i.test(err.message)) { $('#demoErr').textContent = err.message; btn.disabled = false; return; }
    const p = synthetic(symbol), cfg = { ...PRESETS[preset], capital: 10000 }, b = backtest(p, cfg, warmupFor(cfg), p.length);
    const step = Math.max(1, Math.floor(b.eq.length / 200));
    r = { symbol, source: 'synthetic', m: b.m, projection: projectAnnual(b.eq), curve: b.eq.filter((_, i) => i % step === 0), bh: b.bh.filter((_, i) => i % step === 0) };
  }
  draw($('#demoChart'), r.curve, 10000, r.bh);
  const m = r.m, p = r.projection || {};
  $('#demoStats').innerHTML = [
    ['Strategy return', `<b class="${cls(m.ret)}">${pct(m.ret)}</b>`], ['Buy & hold', `<b class="${cls(m.bh)}">${pct(m.bh)}</b>`],
    ['Max drawdown', `<b class="neg">-${m.dd.toFixed(1)}%</b>`], ['Sharpe', `<b>${isFinite(m.sharpe) ? m.sharpe.toFixed(2) : '-'}</b>`],
    ['Typical year (projected)', `<b class="${cls(p.median)}">${pct(p.median)}</b>`], ['Chance of a losing year', `<b>${isFinite(p.probLoss) ? p.probLoss.toFixed(0) + '%' : '-'}</b>`],
  ].map(([k, v]) => `<div class="stat"><span>${k}</span>${v}</div>`).join('');
  $('#demoSrc').textContent = r.source === 'synthetic' ? 'Simulated prices (live data unavailable). Grey line: buy & hold.' : `${r.symbol} daily data since 2015. Grey line: buy & hold. Hypothetical results.`;
  btn.disabled = false;
}
if ($('#demoForm')) { $('#demoForm').addEventListener('submit', runDemo); runDemo(); }

const cf = $('#contactForm');
if (cf) cf.addEventListener('submit', async e => {
  e.preventDefault();
  const out = $('#contactErr'), btn = cf.querySelector('button');
  btn.disabled = true; out.className = 'err'; out.textContent = '';
  try {
    await post('/api/public/contact', Object.fromEntries(new FormData(cf)));
    cf.reset(); out.className = 'ok'; out.textContent = 'Thanks, your message was sent. We will reply by email.';
  } catch (err) { out.textContent = standalone ? 'Messaging is not available yet. Please try again soon.' : err.message; }
  btn.disabled = false;
});
