// QuantPocket single-page client. Hash routes, no framework.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = x => (x < 0 ? '-$' : '$') + Math.abs(+x || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (x, d = 1) => (isFinite(x) ? (x > 0 ? '+' : '') + (+x).toFixed(d) + '%' : '-');
const num = (x, d = 2) => (isFinite(x) ? (+x).toFixed(d) : '-');
const cls = x => (x > 0 ? 'pos' : x < 0 ? 'neg' : '');
const date = t => new Date(t).toLocaleString();

async function api(path, opts = {}) {
  const r = await fetch('/api' + path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'qp' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || r.statusText);
  return d;
}
const form = el => Object.fromEntries($$('[name]', el).map(i => [i.name, i.type === 'checkbox' ? i.checked : i.value]));

// Wire a button to an async action with an error/ok line under it.
function act(btn, fn, out) {
  btn.onclick = async e => {
    e.preventDefault();
    let o = out || btn.parentElement.querySelector('.err');
    if (!o) { o = document.createElement('div'); btn.after(o); }
    btn.disabled = true; o.className = 'err'; o.textContent = '';
    try { const m = await fn(); if (typeof m === 'string') { o.className = 'ok'; o.textContent = m; } }
    catch (err) { o.className = 'err'; o.textContent = err.message; }
    btn.disabled = false;
  };
}

let ME = null, CFG = null;
const state = { account: localStorage.getItem('qp_account') || 'paper' };

// ---------- chart: line is green above the starting value and red below it ----------
function drawChart(canvas, series, { base, compare } = {}) {
  const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const g = canvas.getContext('2d'); g.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement), C = k => css.getPropertyValue(k).trim();
  if (series.length < 2) { g.fillStyle = C('--mu'); g.font = '14px system-ui'; g.fillText('Your equity curve starts filling in after the first trading day.', 12, 28); return; }
  base ??= series[0];
  const all = [...series, ...(compare || []), base];
  let lo = Math.min(...all), hi = Math.max(...all); if (hi === lo) { hi += 1; lo -= 1; }
  const pad = 8, X = i => pad + (i / Math.max(series.length - 1, 1)) * (w - 2 * pad), Y = v => pad + (1 - (v - lo) / (hi - lo)) * (h - 2 * pad);
  const yb = Y(base);
  g.strokeStyle = C('--bd'); g.setLineDash([4, 4]); g.beginPath(); g.moveTo(0, yb); g.lineTo(w, yb); g.stroke(); g.setLineDash([]);
  if (compare) { g.strokeStyle = C('--mu'); g.lineWidth = 1; g.beginPath(); compare.forEach((v, i) => (i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v)))); g.stroke(); }
  const path = () => { g.beginPath(); series.forEach((v, i) => (i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v)))); };
  for (const [color, y0, y1] of [[C('--gr'), 0, yb], [C('--rd'), yb, h]]) {
    g.save(); g.beginPath(); g.rect(0, y0, w, y1 - y0); g.clip();
    path(); g.lineTo(X(series.length - 1), yb); g.lineTo(X(0), yb); g.closePath();
    g.globalAlpha = 0.14; g.fillStyle = color; g.fill(); g.globalAlpha = 1;
    path(); g.lineWidth = 2; g.strokeStyle = color; g.stroke(); g.restore();
  }
}

// ---------- routing ----------
const NAV = [['dashboard', 'Portfolio'], ['backtest', 'Backtest'], ['bots', 'Strategies & Bots'], ['quantconnect', 'QuantConnect'], ['schedule', 'Scheduled'], ['text', 'Text & Hotline'], ['tax', 'Taxes'], ['funding', 'Funding & Plans'], ['settings', 'Settings']];
const routes = {};
async function render() {
  const [route, q] = (location.hash.slice(2) || 'dashboard').split('?');
  const view = $('#view');
  if (!ME && !['login', 'register', 'mfa', 'forgot', 'reset', 'verify'].includes(route)) { location.hash = '#/login'; return; }
  $('#top').hidden = !ME;
  if (ME) $('#nav').innerHTML = [...NAV, ...(ME.role === 'admin' ? [['admin', 'Admin']] : [])].map(([k, t]) => `<a href="#/${k}" class="${k === route ? 'on' : ''}">${t}</a>`).join('');
  view.innerHTML = '<p class="mu">Loading…</p>';
  try {
    await (routes[route] || routes.dashboard)(view, new URLSearchParams(q));
    if (ME && !ME.emailVerified && !['verify'].includes(route)) {
      const b = document.createElement('div'); b.className = 'banner';
      b.innerHTML = 'Please confirm your email address. <a href="#" id="resend">Resend the link</a>';
      view.prepend(b);
      $('#resend', b).onclick = async e => { e.preventDefault(); await api('/auth/verify/resend', { body: {} }); b.textContent = 'Sent. Check your inbox.'; };
    }
  }
  catch (e) { view.innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}
window.addEventListener('hashchange', render);
$('#logout').onclick = async () => { await api('/auth/logout', { body: {} }); ME = null; location.href = '/'; };

const accountSwitch = () => `<div class="seg" id="acctseg">${[['paper', 'Paper'], ['alpaca', 'Alpaca']].map(([k, t]) => `<button class="${state.account === k ? 'on' : ''}" data-a="${k}">${t}</button>`).join('')}</div>`;
function wireAccountSwitch(view) {
  $$('#acctseg button', view).forEach(b => (b.onclick = () => { state.account = b.dataset.a; localStorage.setItem('qp_account', state.account); render(); }));
}

// ---------- auth ----------
routes.login = view => {
  view.innerHTML = `
  <div class="hero"><h1>Quant<span style="color:var(--ac)">Pocket</span></h1><p class="mu">Backtest, paper trade and automate stock strategies. Connect Alpaca and QuantConnect, trade by text or phone.</p></div>
  <form class="card auth"><h2>Sign in</h2>
    <label>Email<input name="email" type="email" autocomplete="username" required></label>
    <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
    <button>Sign in</button><div class="err"></div>
    <p class="mu"><a href="#/forgot">Forgot password?</a> · New here? <a href="#/register">Create an account</a></p></form>`;
  act($('button', view), async () => {
    const r = await api('/auth/login', { body: form(view) });
    if (r.mfaRequired) { location.hash = '#/mfa'; return; }
    ME = r.user; location.hash = '#/dashboard';
  });
};
routes.register = view => {
  view.innerHTML = `
  <form class="card auth"><h2>Create account</h2>
    <label>Email<input name="email" type="email" autocomplete="username" required></label>
    <label>Password (10+ chars, upper, lower, digit)<input name="password" type="password" autocomplete="new-password" required></label>
    <label><input type="checkbox" name="agree" style="width:auto"> I agree to the <a href="/terms" target="_blank">Terms</a> and <a href="/privacy" target="_blank">Privacy Policy</a> and have read the <a href="/risk" target="_blank">Risk Disclosure</a>.</label>
    <button>Create account</button><div class="err"></div>
    <p class="mu">You start with a $100,000 paper account. <a href="#/login">Sign in instead</a></p></form>`;
  act($('button', view), async () => {
    const f = form(view);
    if (!f.agree) throw new Error('Please accept the Terms to continue');
    ME = (await api('/auth/register', { body: f })).user; location.hash = '#/dashboard';
  });
};
routes.forgot = view => {
  view.innerHTML = `<form class="card auth"><h2>Reset your password</h2><p class="mu">Enter your email and we will send you a reset link.</p>
    <label>Email<input name="email" type="email" autocomplete="username" required></label>
    <button>Send reset link</button><div class="err"></div><p class="mu"><a href="#/login">Back to sign in</a></p></form>`;
  act($('button', view), async () => { await api('/auth/forgot', { body: form(view) }); return 'If that email has an account, a reset link is on its way.'; });
};
routes.reset = (view, q) => {
  view.innerHTML = `<form class="card auth"><h2>Choose a new password</h2>
    <label>New password (10+ chars, upper, lower, digit)<input name="password" type="password" autocomplete="new-password" required></label>
    <button>Save password</button><div class="err"></div></form>`;
  act($('button', view), async () => { await api('/auth/reset', { body: { ...form(view), token: q.get('token') } }); setTimeout(() => (location.hash = '#/login'), 1500); return 'Password changed. You can sign in now.'; });
};
routes.verify = async (view, q) => {
  try { await api('/auth/verify', { body: { token: q.get('token') } }); if (ME) ME.emailVerified = true; view.innerHTML = `<div class="card auth"><h2>Email confirmed</h2><p><a href="#/dashboard">Continue</a></p></div>`; }
  catch (e) { view.innerHTML = `<div class="card auth"><h2>Link problem</h2><p class="err">${esc(e.message)}</p></div>`; }
};
routes.mfa = view => {
  view.innerHTML = `<form class="card auth"><h2>Two-factor code</h2><p class="mu">Open your authenticator app.</p>
    <label>6-digit code<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></label>
    <button>Verify</button><div class="err"></div></form>`;
  act($('button', view), async () => { ME = (await api('/auth/mfa', { body: form(view) })).user; location.hash = '#/dashboard'; });
};

// ---------- portfolio ----------
routes.dashboard = async view => {
  const a = await api('/account?account=' + state.account).catch(e => ({ error: e.message }));
  if (a.error) {
    view.innerHTML = `<div class="row" style="justify-content:space-between"><h1>Portfolio</h1>${accountSwitch()}</div><div class="card"><p class="err">${esc(a.error)}</p><a href="#/settings">Open Settings</a></div>`;
    return wireAccountSwitch(view);
  }
  const base = a.startCash ?? a.history[0]?.equity ?? a.equity;
  const pnl = a.equity - base, pnlPct = base ? pnl / base * 100 : 0;
  const steps = [[ME.emailVerified, 'Confirm your email', '#/dashboard'], [ME.totpEnabled, 'Turn on two-factor login', '#/settings'], [a.positions.length > 0 || state.account !== 'paper', 'Place your first paper trade', '#/dashboard'],
    [ME.phoneVerified && ME.hasPin, 'Add your phone and PIN for SMS', '#/settings'], [!!sessionStorage.getItem('qp_strategy'), 'Backtest a strategy', '#/backtest']];
  const todo = steps.filter(x => !x[0]).length > 1 && !localStorage.getItem('qp_onboard_done');
  view.innerHTML = `
  ${todo ? `<div class="card"><div class="row" style="justify-content:space-between"><h2>Get started</h2><button class="ghost small" id="hideOnboard">Hide</button></div>
    ${steps.map(([done, t, href]) => `<p style="margin:6px 0">${done ? '✅' : '⬜'} <a href="${href}">${t}</a></p>`).join('')}</div>` : ''}
  <div class="row" style="justify-content:space-between"><h1>Portfolio ${a.live ? '<span class="pill warn">LIVE MONEY</span>' : state.account === 'alpaca' ? '<span class="pill">Alpaca paper</span>' : '<span class="pill">Simulated</span>'}</h1>${accountSwitch()}</div>
  <div class="card">
    <div class="stats">
      <div class="stat"><span>Equity</span><b>${money(a.equity)}</b></div>
      <div class="stat"><span>Profit / loss</span><b class="${cls(pnl)}">${money(pnl)} (${pct(pnlPct, 2)})</b></div>
      <div class="stat"><span>Cash</span><b>${money(a.cash)}</b></div>
      <div class="stat"><span>Positions</span><b>${a.positions.length}</b></div>
    </div>
    <canvas id="eqc"></canvas>
    <p class="mu" style="font-size:12px">The line turns green above your starting value and red below it.</p>
  </div>
  <div class="grid">
    <div class="card"><h2>Positions</h2><div class="tablewrap"><table><tr><th>Symbol</th><th>Qty</th><th>Avg</th><th>Price</th><th>Value</th><th>P/L</th></tr>
      ${a.positions.map(p => `<tr><td>${esc(p.symbol)}</td><td>${num(p.qty, 4)}</td><td>${money(p.avgPrice)}</td><td>${money(p.price)}</td><td>${money(p.value)}</td><td class="${cls(p.pnl)}">${money(p.pnl)}</td></tr>`).join('') || '<tr><td colspan="6" class="mu">No positions</td></tr>'}
    </table></div></div>
    <form class="card" id="ticket"><h2>Trade</h2>
      <div class="row"><label>Symbol<input name="symbol" value="SPY" required></label>
        <label>Side<select name="side"><option value="buy">Buy</option><option value="sell">Sell</option></select></label></div>
      <div class="row"><label>Shares<input name="qty" type="number" step="any" min="0"></label><label>or Dollars<input name="notional" type="number" step="any" min="0"></label></div>
      <button>Place market order</button> <button type="button" class="ghost" id="quote">Quote</button><div class="err"></div>
      ${a.live ? '<p class="warn">This sends a real order with real money.</p>' : ''}
    </form>
  </div>
  <div class="card"><h2>Recent orders</h2><div class="tablewrap" id="orders"><p class="mu">Loading…</p></div>
    ${state.account === 'paper' ? '<button class="ghost small" id="reset">Reset paper account</button>' : ''}</div>`;
  wireAccountSwitch(view);
  if ($('#hideOnboard', view)) $('#hideOnboard', view).onclick = () => { try { localStorage.setItem('qp_onboard_done', '1'); } catch {} render(); };
  drawChart($('#eqc', view), a.history.map(x => x.equity), { base });
  const t = $('#ticket', view);
  act($('button', t), async () => {
    const f = form(t);
    if (a.live && !confirm(`Send a LIVE ${f.side} order for ${f.symbol}?`)) return;
    const r = await api('/orders', { body: { ...f, account: state.account } });
    setTimeout(render, 600);
    return `${r.side} ${r.symbol}: ${r.status}${r.price ? ' @ ' + money(r.price) : ''}`;
  });
  act($('#quote', t), async () => { const q = await api('/quote/' + encodeURIComponent(form(t).symbol)); return `${q.symbol} ${money(q.price)}`; });
  if ($('#reset', view)) act($('#reset', view), async () => { if (confirm('Reset paper account to $100,000?')) { await api('/paper/reset', { body: {} }); render(); } });
  const orders = await api('/orders?account=' + state.account).catch(() => []);
  $('#orders', view).innerHTML = `<table><tr><th>Time</th><th>Symbol</th><th>Side</th><th>Qty</th><th>Price</th><th>Status</th><th>Source</th></tr>${orders.map(o => `<tr><td>${date(o.at)}</td><td>${esc(o.symbol)}</td><td>${o.side}</td><td>${o.qty ? num(o.qty, 4) : money(o.notional)}</td><td>${o.price ? money(o.price) : '-'}</td><td>${esc(o.status)}</td><td>${esc(o.source || '')}</td></tr>`).join('') || '<tr><td colspan="7" class="mu">None yet</td></tr>'}</table>`;
};

// ---------- backtest + AI builder ----------
routes.backtest = async (view, q) => {
  CFG ||= await api('/config');
  const s = JSON.parse(sessionStorage.getItem('qp_strategy') || 'null') || { symbol: 'SPY', ...CFG.presets['SMA cross'], sl: 0, tp: 0, ts: 0, size: 100 };
  view.innerHTML = `
  <h1>Backtest</h1>
  ${CFG.marketData ? '' : '<div class="banner">No market-data key on the server: backtests use synthetic prices until you connect Alpaca in Settings.</div>'}
  <div class="card"><h2>Describe a strategy in plain English ${CFG.ai ? '<span class="pill">Claude</span>' : ''}</h2>
    <div class="row"><label style="flex:4">Idea<input id="idea" placeholder="Buy AAPL when RSI drops below 30 in an uptrend, 8% stop loss"></label><button id="build">Build rules</button></div><div class="err"></div><p id="explain" class="mu"></p></div>
  <form class="card" id="bt">
    <div class="row">
      <label>Symbol<input name="symbol" value="${esc(s.symbol)}"></label>
      <label>Start<input name="start" type="date" value="${s.start || '2016-01-01'}"></label>
      <label>Capital<input name="capital" type="number" value="${s.capital || 10000}"></label>
      <label>Preset<select id="preset"><option value="">-</option>${Object.keys(CFG.presets).map(k => `<option>${esc(k)}</option>`).join('')}</select></label>
    </div>
    <div class="row">
      <label style="flex:1 1 300px">Entry rules (all must be true)<textarea name="entry">${esc(s.entry)}</textarea></label>
      <label style="flex:1 1 300px">Exit rules (any)<textarea name="exit">${esc(s.exit)}</textarea></label>
    </div>
    <div class="row">
      <label>Stop loss %<input name="sl" type="number" step="any" value="${s.sl || 0}"></label>
      <label>Take profit %<input name="tp" type="number" step="any" value="${s.tp || 0}"></label>
      <label>Trailing stop %<input name="ts" type="number" step="any" value="${s.ts || 0}"></label>
      <label>Position size %<input name="size" type="number" value="${s.size || 100}"></label>
      <label>Cost per side %<input name="cost" type="number" step="any" value="0.15"></label>
    </div>
    <p class="mu" style="font-size:12px">Indicators: Close, SMA(n), EMA(n), RSI(n), BBU(n,k), BBL(n,k), HIGH(n), LOW(n), ROC(n), MACD(f,s), MACDSIG(f,s,sig). Ops: &gt; &lt; &gt;= &lt;= crosses_above crosses_below.
    Optimizer: put choices in braces, e.g. <code>SMA({10,20,50}) crosses_above SMA({100,200})</code>.</p>
    <button>Run backtest</button> <button type="button" class="ghost" id="save">Save strategy</button><div class="err"></div>
  </form>
  <div id="result"></div>`;
  const f = $('#bt', view);
  $('#preset', view).onchange = e => { const p = CFG.presets[e.target.value]; if (p) { f.entry.value = p.entry; f.exit.value = p.exit; } };
  act($('#build', view), async () => {
    const r = await api('/ai/strategy', { body: { prompt: $('#idea', view).value } });
    f.symbol.value = r.symbol; f.entry.value = r.entry; f.exit.value = r.exit; f.sl.value = r.stopLoss; f.tp.value = r.takeProfit; f.ts.value = r.trailingStop;
    $('#explain', view).textContent = `${r.name}: ${r.explanation}`;
    return 'Rules filled in below. Run the backtest to check them.';
  });
  act($('#save', view), async () => {
    const name = prompt('Name this strategy', f.symbol.value + ' strategy'); if (!name) return;
    await api('/strategies', { body: { ...form(f), name } }); return 'Saved. Deploy it from Strategies & Bots.';
  });
  act($('button', f), async () => {
    const body = form(f); sessionStorage.setItem('qp_strategy', JSON.stringify(body));
    const r = await api('/backtest', { body });
    $('#result', view).innerHTML = r.optimize ? optimizeHtml(r.optimize) : resultHtml(r);
    if (!r.optimize) drawChart($('#btc', view), r.curve.map(x => x.eq), { base: +body.capital, compare: r.curve.map(x => x.bh) });
  });
  if (q.get('run')) $('button', f).click();
};
function resultHtml(r) {
  const m = r.m, p = r.projection, w = r.walkForward;
  return `<div class="card"><h2>${esc(r.symbol)} results ${r.source === 'synthetic' ? '<span class="pill warn">synthetic data</span>' : ''}</h2>
    <div class="stats">
      <div class="stat"><span>Total return</span><b class="${cls(m.ret)}">${pct(m.ret)}</b></div>
      <div class="stat"><span>Buy & hold</span><b class="${cls(m.bh)}">${pct(m.bh)}</b></div>
      <div class="stat"><span>CAGR</span><b class="${cls(m.cagr)}">${pct(m.cagr)}</b></div>
      <div class="stat"><span>Max drawdown</span><b class="${cls(-m.dd)}">-${num(m.dd, 1)}%</b></div>
      <div class="stat"><span>Sharpe / Sortino</span><b>${num(m.sharpe)} / ${num(m.sortino)}</b></div>
      <div class="stat"><span>Volatility</span><b>${num(m.vol, 1)}%</b></div>
      <div class="stat"><span>Trades / win rate</span><b>${m.trades} / ${num(m.win, 0)}%</b></div>
      <div class="stat"><span>Profit factor</span><b>${num(m.profitFactor)}</b></div>
      <div class="stat"><span>Time in market</span><b>${num(m.exposure, 0)}%</b></div>
    </div>
    <canvas id="btc"></canvas><p class="mu" style="font-size:12px">Colored line: strategy (green above starting capital, red below). Grey: buy & hold. ${r.holding ? 'Currently in a position.' : 'Currently flat.'}</p></div>
  <div class="grid">
    ${p ? `<div class="card"><h2>Projected next-year return</h2>
      <p class="mu" style="font-size:13px">2,000 simulated years built by resampling this strategy's own daily returns. A range of outcomes, not a promise.</p>
      <div class="stats">
        <div class="stat"><span>Bad year (5th pct)</span><b class="${cls(p.p5)}">${pct(p.p5)}</b></div>
        <div class="stat"><span>Typical (median)</span><b class="${cls(p.median)}">${pct(p.median)}</b></div>
        <div class="stat"><span>Good year (95th)</span><b class="${cls(p.p95)}">${pct(p.p95)}</b></div>
        <div class="stat"><span>Chance of a loss</span><b>${num(p.probLoss, 0)}%</b></div>
      </div></div>` : ''}
    ${w ? `<div class="card"><h2>Walk-forward check</h2><p class="mu" style="font-size:13px">Beat buy & hold in ${num(w.beatRate, 0)}% of out-of-sample periods.</p>
      <div class="tablewrap"><table><tr><th>Period</th><th>Strategy</th><th>Buy & hold</th><th>Max DD</th></tr>
      ${w.folds.map(x => `<tr><td>${esc(x.from)} → ${esc(x.to)}</td><td class="${cls(x.ret)}">${pct(x.ret)}</td><td class="${cls(x.bh)}">${pct(x.bh)}</td><td>-${num(x.dd, 1)}%</td></tr>`).join('')}</table></div></div>` : ''}
  </div>
  <div class="card"><h2>Trades</h2><div class="tablewrap"><table><tr><th>Entry</th><th>Exit</th><th>Buy</th><th>Sell</th><th>P/L</th><th>Reason</th></tr>
    ${r.trades.slice().reverse().map(t => `<tr><td>${esc(t.entryDate)}</td><td>${esc(t.exitDate)}</td><td>${num(t.entry)}</td><td>${num(t.exit)}</td><td class="${cls(t.pnlPct)}">${pct(t.pnlPct)}</td><td>${esc(t.reason)}</td></tr>`).join('') || '<tr><td colspan="6" class="mu">No closed trades</td></tr>'}
  </table></div></div>`;
}
function optimizeHtml(o) {
  return `<div class="card"><h2>Optimizer (${o.runs} combinations)</h2><p class="mu">${esc(o.note)}</p><div class="tablewrap"><table>
    <tr><th>Entry</th><th>Exit</th><th>In-sample Sharpe</th><th>In-sample return</th><th>Out-of-sample Sharpe</th><th>Out-of-sample return</th></tr>
    ${o.best.map(b => `<tr><td><code>${esc(b.entry)}</code></td><td><code>${esc(b.exit)}</code></td><td>${num(b.inSharpe)}</td><td class="${cls(b.inRet)}">${pct(b.inRet)}</td><td>${num(b.oosSharpe)}</td><td class="${cls(b.oosRet)}">${pct(b.oosRet)}</td></tr>`).join('')}
  </table></div></div>`;
}

// ---------- saved strategies / bots ----------
routes.bots = async view => {
  const list = await api('/strategies');
  view.innerHTML = `<h1>Strategies & Bots</h1>
  <div class="banner">A deployed bot checks its rules once per trading day shortly before the 4 pm New York close and buys or sells on the chosen account. Text BOTS to see them, PAUSE &lt;PIN&gt; to stop all.</div>
  <div class="card tablewrap"><table><tr><th>Name</th><th>Symbol</th><th>Entry</th><th>Exit</th><th>Running on</th><th>Last action</th><th></th></tr>
  ${list.map(s => `<tr data-id="${s.id}"><td>${esc(s.name)}</td><td>${esc(s.symbol)}</td><td><code>${esc(s.entry)}</code></td><td><code>${esc(s.exit)}</code></td>
    <td>${s.deployed ? `<span class="pill ${s.deployed === 'alpaca' ? 'warn' : ''}">${s.deployed}</span>` : '<span class="mu">off</span>'}</td><td>${esc(s.last_action || '')}</td>
    <td><button class="small ghost" data-do="test">Backtest</button> ${s.deployed ? '<button class="small danger" data-do="stop">Stop</button>' : '<button class="small" data-do="paper">Run on paper</button> <button class="small ghost" data-do="alpaca">Run on Alpaca</button>'} <button class="small ghost" data-do="del">Delete</button></td></tr>`).join('') || '<tr><td colspan="7" class="mu">Save a strategy from the Backtest page first.</td></tr>'}
  </table><div class="err" id="botErr"></div></div>`;
  $$('button[data-do]', view).forEach(b => (b.onclick = async () => {
    const id = b.closest('tr').dataset.id, s = list.find(x => x.id == id), d = b.dataset.do;
    try {
      if (d === 'test') { sessionStorage.setItem('qp_strategy', JSON.stringify(s)); location.hash = '#/backtest?run=1'; return; }
      if (d === 'del') { if (!confirm('Delete?')) return; await api('/strategies/' + id, { method: 'DELETE' }); }
      else {
        if (d === 'alpaca' && !confirm('This bot will place orders on your Alpaca account automatically. Continue?')) return;
        await api(`/strategies/${id}/deploy`, { body: { account: d === 'stop' ? null : d } });
      }
      render();
    } catch (e) { $('#botErr', view).textContent = e.message; }
  }));
};

// ---------- QuantConnect ----------
routes.quantconnect = async view => {
  const integ = await api('/integrations');
  if (!integ.quantconnect.connected) {
    view.innerHTML = `<h1>QuantConnect</h1><div class="card"><p>Run full LEAN algorithms (Python or C#, multi-asset, universe selection, options, futures) in QuantConnect's cloud with institutional data.</p>
      <p class="mu">Connect your QuantConnect user id and API token in <a href="#/settings">Settings</a>. Find them at quantconnect.com → Account → API Access.</p></div>`;
    return;
  }
  const [projects, templates] = await Promise.all([api('/qc/projects'), api('/qc/templates')]);
  view.innerHTML = `<h1>QuantConnect</h1>
  <form class="card" id="newp"><h2>New cloud project</h2>
    <div class="row"><label>Template<select name="template">${templates.map(t => `<option>${esc(t)}</option>`).join('')}<option value="">Paste my own code…</option></select></label><label>Name<input name="name" placeholder="My algorithm"></label></div>
    <label>Python code (only when pasting your own)<textarea name="code" rows="8" placeholder="from AlgorithmImports import *"></textarea></label>
    <button>Create project</button><div class="err"></div></form>
  <div class="card"><h2>Your projects</h2><div class="tablewrap"><table><tr><th>Name</th><th>Language</th><th>Modified</th><th></th></tr>
    ${projects.map(p => `<tr data-id="${p.id}"><td>${esc(p.name)}</td><td>${esc(p.language)}</td><td>${esc(p.modified)}</td><td><button class="small" data-do="run">Backtest</button> <button class="small ghost" data-do="list">Results</button></td></tr>`).join('')}
  </table></div><div class="err" id="qcErr"></div></div><div id="qcOut"></div>`;
  act($('button', $('#newp', view)), async () => { const r = await api('/qc/projects', { body: form($('#newp', view)) }); setTimeout(render, 800); return 'Created project ' + r.id; });
  const out = $('#qcOut', view);
  const show = async (pid, bid) => {
    const b = await api(`/qc/projects/${pid}/backtests/${bid}`);
    out.innerHTML = `<div class="card"><h2>${esc(b.name)} ${b.completed ? '' : `<span class="pill">${num(b.progress * 100, 0)}%</span>`}</h2>${b.error ? `<pre class="err">${esc(b.error)}</pre>` : ''}
      <div class="stats">${Object.entries(b.statistics).map(([k, v]) => `<div class="stat"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div></div>`;
    if (!b.completed && !b.error) setTimeout(() => location.hash === '#/quantconnect' && show(pid, bid), 4000);
  };
  $$('button[data-do]', view).forEach(btn => (btn.onclick = async () => {
    const pid = btn.closest('tr').dataset.id;
    btn.disabled = true; $('#qcErr', view).textContent = '';
    try {
      if (btn.dataset.do === 'run') { const r = await api(`/qc/projects/${pid}/backtest`, { body: {} }); await show(pid, r.backtestId); }
      else {
        const list = await api(`/qc/projects/${pid}/backtests`);
        out.innerHTML = `<div class="card"><h2>Backtests</h2>${list.map(b => `<p><a href="#" data-b="${esc(b.id)}">${esc(b.name)}</a> <span class="mu">${esc(b.created)}</span></p>`).join('') || '<p class="mu">None yet</p>'}</div>`;
        $$('a[data-b]', out).forEach(a => (a.onclick = e => { e.preventDefault(); show(pid, a.dataset.b); }));
      }
    } catch (e) { $('#qcErr', view).textContent = e.message; }
    btn.disabled = false;
  }));
};

// ---------- scheduled trades + alerts ----------
routes.schedule = async view => {
  const [rows, alerts] = await Promise.all([api('/schedule'), api('/alerts')]);
  const soon = new Date(Date.now() + 3600e3); soon.setMinutes(30, 0, 0);
  const local = new Date(soon.getTime() - soon.getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
  view.innerHTML = `<h1>Scheduled trades</h1>
  <form class="card" id="sch"><h2>New scheduled order</h2>
    <div class="row"><label>Account<select name="account"><option value="paper">Paper</option><option value="alpaca">Alpaca</option></select></label>
      <label>Side<select name="side"><option value="buy">Buy</option><option value="sell">Sell</option></select></label>
      <label>Symbol<input name="symbol" value="SPY"></label></div>
    <div class="row"><label>Shares<input name="qty" type="number" step="any"></label><label>or Dollars<input name="notional" type="number" step="any" value="100"></label>
      <label>First run<input name="at" type="datetime-local" value="${local}"></label>
      <label>Repeat<select name="repeat"><option value="once">Once</option><option value="daily">Every trading day</option><option value="weekly" selected>Weekly (DCA)</option><option value="monthly">Monthly</option></select></label></div>
    <button>Schedule</button><div class="err"></div></form>
  <div class="card tablewrap"><table><tr><th>#</th><th>Order</th><th>Account</th><th>Repeat</th><th>Next run</th><th>Last result</th><th></th></tr>
    ${rows.map(o => `<tr class="${o.active ? '' : 'mu'}"><td>${o.id}</td><td>${o.side} ${o.qty ? num(o.qty, 4) : money(o.notional)} ${esc(o.symbol)}</td><td>${o.account}</td><td>${o.repeat}</td><td>${o.active ? date(o.next_run) : 'done'}</td><td>${esc(o.last_result || '')}</td><td>${o.active ? `<button class="small ghost" data-c="${o.id}">Cancel</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="mu">Nothing scheduled</td></tr>'}
  </table></div>
  <form class="card" id="al"><h2>Price alerts (sent by SMS)</h2>
    <div class="row"><label>Symbol<input name="symbol" value="AAPL"></label><label>When price is<select name="op"><option>above</option><option>below</option></select></label><label>Price<input name="price" type="number" step="any"></label><button>Add alert</button></div><div class="err"></div>
    <table>${alerts.map(a => `<tr class="${a.active ? '' : 'mu'}"><td>${esc(a.symbol)} ${a.op} ${money(a.price)}</td><td>${a.active ? 'watching' : 'triggered'}</td><td><button class="small ghost" data-a="${a.id}">Remove</button></td></tr>`).join('')}</table></form>`;
  act($('button', $('#sch', view)), async () => { const f = form($('#sch', view)); await api('/schedule', { body: { ...f, at: new Date(f.at).toISOString() } }); render(); });
  act($('button', $('#al', view)), async () => { await api('/alerts', { body: form($('#al', view)) }); render(); });
  $$('[data-c]', view).forEach(b => (b.onclick = async () => { await api('/schedule/' + b.dataset.c, { method: 'DELETE' }); render(); }));
  $$('[data-a]', view).forEach(b => (b.onclick = async e => { e.preventDefault(); await api('/alerts/' + b.dataset.a, { method: 'DELETE' }); render(); }));
};

// ---------- text & hotline ----------
routes.text = async view => {
  CFG ||= await api('/config');
  const { help } = await api('/command/help');
  view.innerHTML = `<h1>Text & Hotline</h1>
  <div class="grid">
    <div class="card"><h2>Manage your account by SMS or phone</h2>
      <p>${CFG.hotline ? `Text or call <b>${esc(CFG.hotline)}</b> from your verified phone.` : '<span class="warn">The SMS/voice number is not configured on this server yet (Twilio).</span>'}</p>
      <p class="mu">Status: phone ${ME.phone ? esc(ME.phone) : 'not set'} ${ME.phoneVerified ? '<span class="pill">verified</span>' : ''} · PIN ${ME.hasPin ? 'set' : 'not set'} — <a href="#/settings">change in Settings</a></p>
      <pre>${esc(help)}</pre>
      <p class="mu">On the hotline: enter your PIN, then press 1 balance, 2 positions, 3 scheduled trades, 9 pause bots, or say a command like "buy five shares of Apple".</p></div>
    <div class="card"><h2>Try a command here</h2>
      <label>Command<input id="cmd" placeholder="BAL"></label><button id="send">Send</button><div class="err"></div><pre id="reply"></pre></div>
  </div>`;
  act($('#send', view), async () => { $('#reply', view).textContent = (await api('/command', { body: { text: $('#cmd', view).value } })).reply; });
  $('#cmd', view).onkeydown = e => { if (e.key === 'Enter') $('#send', view).click(); };
};

// ---------- tax ----------
routes.tax = async (view, q) => {
  const year = +(q.get('year') || new Date().getFullYear());
  const t = await api(`/tax?account=${state.account}&year=${year}`);
  view.innerHTML = `<div class="row" style="justify-content:space-between"><h1>Tax information</h1>${accountSwitch()}</div>
  <div class="banner">Estimates for planning only (US federal + flat state rate, FIFO lots). Your broker's 1099-B is the official record; check with a tax professional.</div>
  <div class="card"><div class="row"><label>Year<select id="yr">${[0, 1, 2, 3].map(i => new Date().getFullYear() - i).map(y => `<option ${y === year ? 'selected' : ''}>${y}</option>`).join('')}</select></label>
    <a href="/api/tax?account=${state.account}&year=${year}&format=csv"><button type="button" class="ghost">Download Form 8949 CSV</button></a></div>
    <div class="stats" style="margin-top:12px">
      <div class="stat"><span>Short-term gains</span><b class="${cls(t.shortTerm)}">${money(t.shortTerm)}</b></div>
      <div class="stat"><span>Long-term gains</span><b class="${cls(t.longTerm)}">${money(t.longTerm)}</b></div>
      <div class="stat"><span>Wash-sale disallowed</span><b>${money(t.washSaleDisallowed)}</b></div>
      <div class="stat"><span>Net</span><b class="${cls(t.net)}">${money(t.net)}</b></div>
      <div class="stat"><span>Estimated tax</span><b>${money(t.estimatedTax)}</b></div>
      <div class="stat"><span>Loss carryforward</span><b>${money(t.carryforward)}</b></div>
    </div>
    <p class="mu" style="font-size:13px">Rates used: ordinary ${num(t.bracket * 100, 0)}%, long-term ${num(t.ltRate * 100, 0)}%, state ${num(t.stateRate * 100, 1)}%. Change them in Settings.</p></div>
  ${t.harvest.length ? `<div class="card"><h2>Tax-loss harvesting ideas</h2>${t.harvest.map(h => `<p><b>${esc(h.symbol)}</b> <span class="neg">${money(h.unrealized)}</span> <span class="mu">${esc(h.note)}</span></p>`).join('')}</div>` : ''}
  <div class="card tablewrap"><h2>Realized sales</h2><table><tr><th>Symbol</th><th>Qty</th><th>Acquired</th><th>Sold</th><th>Proceeds</th><th>Cost</th><th>Gain</th><th>Term</th><th></th></tr>
    ${t.rows.map(r => `<tr><td>${esc(r.symbol)}</td><td>${num(r.qty, 4)}</td><td>${new Date(r.acquired).toLocaleDateString()}</td><td>${new Date(r.sold).toLocaleDateString()}</td><td>${money(r.proceeds)}</td><td>${money(r.cost)}</td><td class="${cls(r.gain)}">${money(r.gain)}</td><td>${r.longTerm ? 'Long' : 'Short'}</td><td>${r.washSale ? '<span class="pill warn">wash sale</span>' : ''}</td></tr>`).join('') || '<tr><td colspan="9" class="mu">No sales this year</td></tr>'}
  </table></div>`;
  wireAccountSwitch(view);
  $('#yr', view).onchange = e => (location.hash = '#/tax?year=' + e.target.value);
};

// ---------- funding & plans ----------
routes.funding = routes.billing = async view => {
  CFG ||= await api('/config');
  const [ledger, fees] = await Promise.all([api('/ledger'), api('/fees')]);
  view.innerHTML = `<h1>Funding & Plans</h1>
  <div class="plans">${Object.entries(CFG.plans).map(([k, p]) => `<div class="card plan"><h2>${esc(p.name)} ${ME.plan === k ? '<span class="pill">current</span>' : ''}</h2>
    <div class="price">${p.monthly ? '$' + p.monthly + '<span class="mu" style="font-size:14px">/mo</span>' : 'Free'}</div>
    <p>+ <b>${p.perfFee * 100}%</b> of new profits <span class="mu">(above your high-water mark, charged monthly)</span></p>
    <ul>${p.features.map(f => `<li>${esc(f)}</li>`).join('')}</ul>
    ${p.monthly && ME.plan !== k ? `<button data-plan="${k}">Choose ${esc(p.name)}</button>` : ''}</div>`).join('')}</div>
  <div class="err" id="planErr"></div>
  <div class="grid">
    <form class="card" id="dep"><h2>Deposit with a debit card</h2>
      <div class="row"><label>Account<select name="account"><option value="paper">Paper (simulated, instant)</option><option value="alpaca">Brokerage (real money)</option></select></label><label>Amount (USD)<input name="amount" type="number" min="10" max="10000" value="500"></label></div>
      <button>Deposit</button><div class="err"></div>
      <p class="mu" style="font-size:13px">Real deposits are processed by Stripe; only debit cards are accepted and credit cards are refunded automatically. Funds are credited to your brokerage account after the transfer clears.</p></form>
    <div class="card"><h2>Performance fee</h2><p>Your rate: <b>${fees.rate * 100}%</b> of new profit. You only pay when an account is above its previous peak, after deposits and withdrawals.</p>
      ${fees.accounts.map(a => `<p class="mu">${a.account}: high-water mark ${money(a.high_water)}</p>`).join('')}</div>
  </div>
  <div class="card tablewrap"><h2>Ledger</h2><table><tr><th>Date</th><th>Type</th><th>Amount</th><th>Status</th><th>Note</th></tr>
    ${ledger.map(l => `<tr><td>${date(l.at)}</td><td>${esc(l.kind.replace('_', ' '))}</td><td>${money(l.amount)}</td><td>${esc(l.status)}</td><td>${esc(l.memo || '')}</td></tr>`).join('') || '<tr><td colspan="5" class="mu">Nothing yet</td></tr>'}</table></div>`;
  $$('[data-plan]', view).forEach(b => act(b, async () => { location.href = (await api('/billing/checkout', { body: { plan: b.dataset.plan } })).url; }, $('#planErr', view)));
  act($('button', $('#dep', view)), async () => {
    const r = await api('/funding/deposit', { body: form($('#dep', view)) });
    if (r.url) { location.href = r.url; return; }
    setTimeout(render, 500); return 'Paper deposit added.';
  });
};

// ---------- settings ----------
routes.settings = async view => {
  const [integ, sessions, log] = await Promise.all([api('/integrations'), api('/auth/sessions'), api('/auth/audit')]);
  view.innerHTML = `<h1>Settings</h1>
  <div class="grid">
    <form class="card" id="alp"><h2>Alpaca brokerage</h2>
      <p class="mu">${integ.alpaca.connected ? `Connected (${integ.alpaca.live ? '<b class="warn">live</b>' : 'paper'}) · key ${esc(integ.alpaca.keyHint)}` : 'Create API keys at alpaca.markets. Keys are encrypted on the server.'}</p>
      <label>API key id<input name="keyId" autocomplete="off"></label><label>Secret key<input name="secret" type="password" autocomplete="off"></label>
      <label><input type="checkbox" name="live" style="width:auto"> These are LIVE (real money) keys</label>
      <button>${integ.alpaca.connected ? 'Replace keys' : 'Connect Alpaca'}</button> ${integ.alpaca.connected ? '<button type="button" class="ghost" data-dis="alpaca">Disconnect</button>' : ''}<div class="err"></div></form>
    <form class="card" id="qcf"><h2>QuantConnect</h2>
      <p class="mu">${integ.quantconnect.connected ? 'Connected as user ' + esc(integ.quantconnect.userId) : 'quantconnect.com → Account → API Access'}</p>
      <label>User id<input name="userId" autocomplete="off"></label><label>API token<input name="token" type="password" autocomplete="off"></label>
      <button>${integ.quantconnect.connected ? 'Replace' : 'Connect QuantConnect'}</button> ${integ.quantconnect.connected ? '<button type="button" class="ghost" data-dis="quantconnect">Disconnect</button>' : ''}<div class="err"></div></form>
    <div class="card" id="mfa"><h2>Two-factor authentication</h2>
      ${ME.totpEnabled ? `<p class="pos">Enabled</p><label>Password to disable<input type="password" id="mfapw"></label><button class="danger" id="mfaoff">Disable 2FA</button><div class="err"></div>`
        : `<p class="mu">Protect your account with an authenticator app (Google Authenticator, 1Password, Authy).</p><button id="mfaset">Set up 2FA</button><div class="err"></div><div id="mfabox"></div>`}</div>
    <form class="card" id="ph"><h2>Phone for SMS & hotline</h2>
      <p class="mu">${ME.phone ? esc(ME.phone) + (ME.phoneVerified ? ' · verified' : ' · not verified') : 'Not set'}</p>
      <label>Mobile number<input name="phone" placeholder="+17185551234" value="${esc(ME.phone || '')}"></label><button>Send code</button>
      <label>Code<input name="code" inputmode="numeric"></label><button type="button" id="phv">Verify</button><div class="err"></div>
      <h3>Trading PIN</h3><label>Account password<input type="password" name="pinpw"></label><label>New PIN (4-8 digits)<input name="pin" inputmode="numeric"></label><button type="button" id="pinb">Save PIN</button><div class="err"></div></form>
    <form class="card" id="taxs"><h2>Tax rates</h2>
      <label>Federal bracket<select name="bracket">${[0.10, 0.12, 0.22, 0.24, 0.32, 0.35, 0.37].map(b => `<option value="${b}" ${b === ME.taxBracket ? 'selected' : ''}>${b * 100}%</option>`).join('')}</select></label>
      <label>State rate %<input name="stateTax" type="number" step="0.1" value="${ME.stateTax * 100}"></label><button>Save</button><div class="err"></div></form>
    <form class="card" id="pw"><h2>Password</h2><label>Current<input type="password" name="current" autocomplete="current-password"></label><label>New<input type="password" name="next" autocomplete="new-password"></label><button>Change password</button><div class="err"></div>
      <p class="mu" style="font-size:12px">Changing it signs out every other device.</p></form>
  </div>
  <div class="card"><h2>Your data</h2><p class="mu">Download everything we store about you, or permanently delete your account.</p>
    <a href="/api/auth/export"><button type="button" class="ghost">Download my data</button></a>
    <label>Password to delete account<input type="password" id="delpw" autocomplete="current-password"></label><button class="danger" id="delacct">Delete my account</button><div class="err"></div></div>
  <div class="card tablewrap"><h2>Active sessions</h2><table>${sessions.map(s => `<tr><td>${esc(s.ip)}</td><td>${esc(s.ua.slice(0, 60))}</td><td>${date(s.createdAt)}</td><td>${s.current ? '<span class="pill">this device</span>' : `<button class="small ghost" data-s="${s.id}">Sign out</button>`}</td></tr>`).join('')}</table></div>
  <div class="card tablewrap"><h2>Security log</h2><table>${log.map(l => `<tr><td>${date(l.at)}</td><td>${esc(l.event)}</td><td>${esc(l.ip || '')}</td></tr>`).join('')}</table></div>`;
  const refreshMe = async () => { ME = (await api('/auth/me')).user; };
  act($('button', $('#alp', view)), async () => { const r = await api('/integrations/alpaca', { body: form($('#alp', view)) }); setTimeout(render, 800); return 'Connected. Equity ' + money(r.equity); });
  act($('button', $('#qcf', view)), async () => { await api('/integrations/quantconnect', { body: form($('#qcf', view)) }); setTimeout(render, 800); return 'Connected'; });
  $$('[data-dis]', view).forEach(b => (b.onclick = async () => { await api('/integrations/' + b.dataset.dis, { method: 'DELETE' }); render(); }));
  if ($('#mfaset', view)) act($('#mfaset', view), async () => {
    const r = await api('/auth/totp/setup', { body: {} });
    $('#mfabox', view).innerHTML = `<p>Add this key to your authenticator app (or open the link on your phone):</p><pre>${esc(r.secret)}</pre><p><a href="${esc(r.uri)}">${esc(r.uri.slice(0, 40))}…</a></p>
      <label>Code from the app<input id="mfacode" inputmode="numeric" maxlength="6"></label><button id="mfaon">Turn on 2FA</button><div class="err"></div>`;
    act($('#mfaon', view), async () => { await api('/auth/totp/enable', { body: { code: $('#mfacode', view).value } }); await refreshMe(); render(); });
  });
  if ($('#mfaoff', view)) act($('#mfaoff', view), async () => { await api('/auth/totp/disable', { body: { password: $('#mfapw', view).value } }); await refreshMe(); render(); });
  const ph = $('#ph', view);
  act($('button', ph), async () => { const r = await api('/phone', { body: { phone: ph.phone.value } }); await refreshMe(); return r.devCode ? `SMS is off on this server - your dev code is ${r.devCode}` : 'Code sent'; }, $$('.err', ph)[0]);
  act($('#phv', view), async () => { await api('/phone/verify', { body: { code: ph.code.value } }); await refreshMe(); return 'Phone verified'; }, $$('.err', ph)[0]);
  act($('#pinb', view), async () => { await api('/pin', { body: { password: ph.pinpw.value, pin: ph.pin.value } }); await refreshMe(); return 'PIN saved'; }, $$('.err', ph)[1]);
  act($('button', $('#taxs', view)), async () => { const f = form($('#taxs', view)); await api('/tax/settings', { body: { bracket: +f.bracket, stateTax: f.stateTax / 100 } }); await refreshMe(); return 'Saved'; });
  act($('button', $('#pw', view)), async () => { await api('/auth/password', { body: form($('#pw', view)) }); return 'Password changed'; });
  $$('[data-s]', view).forEach(b => (b.onclick = async () => { await api('/auth/sessions/' + b.dataset.s, { method: 'DELETE' }); render(); }));
  act($('#delacct', view), async () => {
    if (!confirm('Delete your account and all data permanently? This cannot be undone. Your Alpaca account is not affected.')) return;
    await api('/auth/delete', { body: { password: $('#delpw', view).value } }); location.href = '/';
  });
};

// ---------- admin ----------
routes.admin = async view => {
  const [s, msgs] = await Promise.all([api('/admin/summary'), api('/admin/messages')]);
  const total = (kind, status) => s.byKind.filter(x => x.kind === kind && (!status || x.status === status)).reduce((a, x) => a + x.total, 0);
  view.innerHTML = `<h1>Admin</h1>
  <div class="card"><div class="stats">
    <div class="stat"><span>Users</span><b>${s.users.length}</b></div>
    <div class="stat"><span>Monthly recurring revenue</span><b>${money(s.mrr)}</b></div>
    <div class="stat"><span>Performance fees due</span><b>${money(total('performance_fee', 'due'))}</b></div>
    <div class="stat"><span>Performance fees collected</span><b>${money(total('performance_fee', 'collected'))}</b></div>
  </div><button id="assess">Assess performance fees now</button><div class="err"></div></div>
  <div class="card tablewrap"><h2>Fees due</h2><table>${s.feesDue.map(l => `<tr><td>${esc(l.email)}</td><td>${money(l.amount)}</td><td>${esc(l.memo)}</td><td><button class="small" data-l="${l.id}" data-s="collected">Mark collected</button> <button class="small ghost" data-l="${l.id}" data-s="waived">Waive</button></td></tr>`).join('') || '<tr><td class="mu">None</td></tr>'}</table></div>
  <div class="card tablewrap"><h2>Card deposits awaiting brokerage transfer</h2><table>${s.pendingTransfers.map(l => `<tr><td>${esc(l.email)}</td><td>${money(l.amount)}</td><td>${date(l.at)}</td><td><button class="small" data-l="${l.id}" data-s="transferred">Mark transferred</button></td></tr>`).join('') || '<tr><td class="mu">None</td></tr>'}</table></div>
  <div class="card tablewrap"><h2>Support inbox</h2><table>${msgs.filter(m => m.status === 'open').map(m => `<tr><td>${date(m.at)}</td><td>${esc(m.name)} &lt;<a href="mailto:${esc(m.email)}">${esc(m.email)}</a>&gt;</td><td><b>${esc(m.subject)}</b><br><span class="mu" style="white-space:pre-wrap">${esc(m.body)}</span></td><td><button class="small ghost" data-m="${m.id}">Done</button></td></tr>`).join('') || '<tr><td class="mu">Inbox zero</td></tr>'}</table></div>
  <div class="card tablewrap"><h2>Users</h2><table><tr><th>Email</th><th>Plan</th><th>Role</th><th>2FA</th><th>Phone</th><th>Joined</th></tr>${s.users.map(u => `<tr><td>${esc(u.email)}</td><td>${u.plan}</td><td>${u.role}</td><td>${u.totp_enabled ? 'yes' : '-'}</td><td>${u.phone_verified ? 'yes' : '-'}</td><td>${date(u.created_at)}</td></tr>`).join('')}</table></div>`;
  act($('#assess', view), async () => { const r = await api('/admin/assess-fees', { body: {} }); setTimeout(render, 1200); return `Assessed ${r.length} accounts, ${money(r.reduce((a, x) => a + (x.fee || 0), 0))} in new fees`; });
  $$('[data-l]', view).forEach(b => (b.onclick = async () => { await api('/admin/ledger/' + b.dataset.l, { body: { status: b.dataset.s } }); render(); }));
  $$('[data-m]', view).forEach(b => (b.onclick = async () => { await api('/admin/messages/' + b.dataset.m, { body: {} }); render(); }));
};

(async () => {
  const me = await api('/auth/me').catch(() => ({}));
  ME = me.user;
  if (!ME && me.mfaPending) location.hash = '#/mfa';
  render();
  window.addEventListener('resize', () => { clearTimeout(window.__rt); window.__rt = setTimeout(() => ['#/dashboard'].includes(location.hash) && render(), 300); });
})();
