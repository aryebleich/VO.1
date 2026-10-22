// Quant Pocket - Expo Go app: login, rule-based backtesting, Alpaca trading.
// Needs: expo-secure-store, expo-crypto, expo-local-authentication, react-native-svg,
// react-native-safe-area-context, expo-status-bar (all included in Expo Go).
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, Alert, AppState, Switch, ActivityIndicator, Dimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import * as LocalAuth from 'expo-local-authentication';
import Svg, { Polyline } from 'react-native-svg';

// ENGINE START
const COST = 0.0015; // 0.1% fee + 0.05% slippage per side
const sma = (p, n) => { const o = Array(p.length).fill(null); let s = 0; for (let i = 0; i < p.length; i++) { s += p[i]; if (i >= n) s -= p[i - n]; if (i >= n - 1) o[i] = s / n; } return o; };
const emaRaw = (p, n) => { const k = 2 / (n + 1), o = [p[0]]; for (let i = 1; i < p.length; i++) o.push(p[i] * k + o[i - 1] * (1 - k)); return o; };
const mask = (a, n) => a.map((v, i) => (i < n ? null : v));
const rsi = (p, n) => { const o = Array(p.length).fill(null); let g = 0, l = 0; for (let i = 1; i < p.length; i++) { const d = p[i] - p[i - 1], u = Math.max(d, 0), w = Math.max(-d, 0); if (i <= n) { g += u / n; l += w / n; } else { g = (g * (n - 1) + u) / n; l = (l * (n - 1) + w) / n; } if (i >= n) o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } return o; };
const bb = (p, n, k, sg) => { const m = sma(p, n); return p.map((_, i) => { if (m[i] == null) return null; let v = 0; for (let j = i - n + 1; j <= i; j++) v += (p[j] - m[i]) ** 2; return m[i] + sg * k * Math.sqrt(v / n); }); };
const macdLine = (p, f, s) => { const a = emaRaw(p, f), b = emaRaw(p, s); return a.map((v, i) => v - b[i]); };

function operand(str, p) {
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
const RULE = /^(.+?)\s*(>=|<=|>|<|CROSSES_ABOVE|CROSSES_BELOW)\s*(.+)$/;
function compile(txt, p) {
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
// Signals use bar i-1; trades fill at the close of bar i (no look-ahead). Stops are checked on closes.
function backtest(p, cfg, from) {
  const en = compile(cfg.entry, p), ex = compile(cfg.exit, p);
  const sl = +cfg.sl || 0, tp = +cfg.tp || 0, ts = +cfg.ts || 0, size = Math.min(+cfg.size || 100, 100);
  let cash = 1e4, sh = 0, ep = 0, pk = 0, trades = 0, closed = 0, wins = 0;
  const eq = [], bh = [];
  for (let i = from; i < p.length; i++) {
    const px = p[i];
    if (sh > 0) {
      pk = Math.max(pk, px);
      const out = (sl && px <= ep * (1 - sl / 100)) || (tp && px >= ep * (1 + tp / 100)) || (ts && px <= pk * (1 - ts / 100)) || (ex.length && ex.some(r => r(i - 1)));
      if (out) { cash += sh * px * (1 - COST); closed++; if (px * (1 - COST) > ep) wins++; sh = 0; }
    } else if (en.length && en.every(r => r(i - 1))) {
      const amt = cash * size / 100; sh = amt * (1 - COST) / px; cash -= amt; ep = px; pk = px; trades++;
    }
    eq.push(cash + sh * px); bh.push(1e4 * px / p[from]);
  }
  const r = eq.slice(1).map((v, i) => v / eq[i] - 1), mu = r.reduce((a, b) => a + b, 0) / r.length;
  const sd = Math.sqrt(r.reduce((a, b) => a + (b - mu) ** 2, 0) / r.length) || 1e-9;
  let peak = eq[0], dd = 0; eq.forEach(v => { peak = Math.max(peak, v); dd = Math.max(dd, (peak - v) / peak); });
  return { eq, bh, holding: sh > 0, m: { ret: (eq[eq.length - 1] / 1e4 - 1) * 100, bh: (bh[bh.length - 1] / 1e4 - 1) * 100, dd: dd * 100, sharpe: mu / sd * Math.sqrt(252), trades, win: closed ? wins / closed * 100 : NaN } };
}
// ENGINE END

const PRESETS = {
  'SMA cross': { entry: 'SMA(20) crosses_above SMA(100)', exit: 'SMA(20) crosses_below SMA(100)' },
  'RSI dip in uptrend': { entry: 'RSI(14) < 30\nClose > SMA(200)', exit: 'RSI(14) > 60' },
  'Bollinger revert': { entry: 'Close < BBL(20,2)', exit: 'Close > SMA(20)' },
  'Breakout': { entry: 'Close > HIGH(55)', exit: 'Close < LOW(20)' },
  'MACD trend': { entry: 'MACD(12,26) crosses_above MACDSIG(12,26,9)\nClose > SMA(200)', exit: 'MACD(12,26) crosses_below MACDSIG(12,26,9)' },
};
const C = { bg: '#0c121c', cd: '#151d2b', tx: '#e6ebf4', mu: '#8d9bb3', ac: '#6d9bff', gr: '#3ddc8a', rd: '#ff7a66', bd: '#263145' };
const Btn = ({ t, on, c, dis }) => <TouchableOpacity disabled={dis} onPress={on} style={{ backgroundColor: c || C.ac, padding: 12, borderRadius: 8, opacity: dis ? 0.5 : 1, alignItems: 'center', marginTop: 8 }}><Text style={{ color: '#fff', fontWeight: '700' }}>{t}</Text></TouchableOpacity>;
const In = p => <TextInput placeholderTextColor={C.mu} autoCapitalize="none" autoCorrect={false} {...p} style={[{ backgroundColor: C.bg, color: C.tx, borderWidth: 1, borderColor: C.bd, borderRadius: 8, padding: 10, marginTop: 4 }, p.style]} />;
const Lb = ({ t }) => <Text style={{ color: C.mu, fontSize: 12, marginTop: 8 }}>{t}</Text>;
const Card = ({ children }) => <View style={{ backgroundColor: C.cd, borderRadius: 12, borderWidth: 1, borderColor: C.bd, padding: 12, marginBottom: 12 }}>{children}</View>;
const H = ({ t }) => <Text style={{ color: C.tx, fontSize: 18, fontWeight: '700' }}>{t}</Text>;
const col = x => (x > 0 ? C.gr : x < 0 ? C.rd : C.tx);
const f = (x, d = 1) => (isFinite(x) ? x.toFixed(d) : '-');

// ---------- auth (local account; hash + salt in SecureStore) ----------
const hex = a => Array.from(a).map(b => b.toString(16).padStart(2, '0')).join('');
async function hashPw(pw, salt) { let h = pw + salt; for (let i = 0; i < 300; i++) h = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, h + salt); return h; }

function Auth({ acct, onOk }) {
  const [u, setU] = useState(''), [pw, setPw] = useState(''), [pw2, setPw2] = useState(''), [err, setErr] = useState(''), [bio, setBio] = useState(false), [busy, setBusy] = useState(false);
  const fails = useRef(0), lock = useRef(0);
  useEffect(() => { (async () => setBio(!!acct && (await LocalAuth.hasHardwareAsync()) && (await LocalAuth.isEnrolledAsync())))(); }, [acct]);
  const reg = async () => {
    if (u.trim().length < 3 || pw.length < 8) return setErr('Username 3+ characters, password 8+ characters.');
    if (pw !== pw2) return setErr('Passwords do not match.');
    setBusy(true); const salt = hex(Crypto.getRandomBytes(16));
    const a = { user: u.trim(), salt, hash: await hashPw(pw, salt) };
    await SecureStore.setItemAsync('acct', JSON.stringify(a)); onOk(a);
  };
  const login = async () => {
    if (Date.now() < lock.current) return setErr('Locked. Try again in ' + Math.ceil((lock.current - Date.now()) / 1000) + 's.');
    setBusy(true); const h = await hashPw(pw, acct.salt); setBusy(false);
    if (h === acct.hash && u.trim() === acct.user) return onOk(acct);
    fails.current++; if (fails.current >= 5) lock.current = Date.now() + 60000 * (fails.current - 4);
    setErr('Wrong username or password.');
  };
  const bioLogin = async () => { const r = await LocalAuth.authenticateAsync({ promptMessage: 'Unlock Quant Pocket' }); if (r.success) onOk(acct); };
  return (
    <ScrollView contentContainerStyle={{ padding: 20, paddingTop: 60 }}>
      <Text style={{ color: C.tx, fontSize: 28, fontWeight: '800' }}>Quant Pocket</Text>
      <Text style={{ color: C.mu, marginBottom: 16 }}>{acct ? 'Sign in' : 'Create your local account'}</Text>
      <Card>
        <Lb t="Username" /><In value={u} onChangeText={setU} />
        <Lb t="Password" /><In value={pw} onChangeText={setPw} secureTextEntry />
        {!acct && <><Lb t="Repeat password" /><In value={pw2} onChangeText={setPw2} secureTextEntry /></>}
        {!!err && <Text style={{ color: C.rd, marginTop: 8 }}>{err}</Text>}
        <Btn t={acct ? 'Sign in' : 'Create account'} on={acct ? login : reg} dis={busy} />
        {bio && <Btn t="Use fingerprint / face" on={bioLogin} c={C.bd} />}
      </Card>
      <Text style={{ color: C.mu, fontSize: 12 }}>The account lives only on this phone. The app locks when it goes to the background.</Text>
    </ScrollView>
  );
}

// ---------- Alpaca ----------
const DATA = 'https://data.alpaca.markets/v2';
const cache = {};
async function getBars(sym, start, cred) {
  if (cache[sym + start]) return cache[sym + start];
  if (!cred.k || !cred.s) throw new Error('Add your Alpaca keys in Settings first.');
  const out = []; let tok = '';
  do {
    const r = await fetch(`${DATA}/stocks/${sym}/bars?timeframe=1Day&start=${start}&limit=10000&adjustment=all&feed=iex${tok ? '&page_token=' + tok : ''}`, { headers: { 'APCA-API-KEY-ID': cred.k, 'APCA-API-SECRET-KEY': cred.s } });
    if (!r.ok) throw new Error(sym + ': ' + r.status + ' ' + (await r.text()).slice(0, 100));
    const d = await r.json(); (d.bars || []).forEach(b => out.push(b.c)); tok = d.next_page_token || '';
  } while (tok);
  if (out.length < 300) throw new Error(sym + ': only ' + out.length + ' bars (need 300+).');
  return (cache[sym + start] = out);
}
const api = async (cred, path, method = 'GET', body) => {
  const r = await fetch((cred.live ? 'https://api.alpaca.markets/v2' : 'https://paper-api.alpaca.markets/v2') + path, { method, headers: { 'APCA-API-KEY-ID': cred.k, 'APCA-API-SECRET-KEY': cred.s, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); if (!r.ok) throw new Error(r.status + ' ' + t.slice(0, 150)); return t ? JSON.parse(t) : {};
};

function Chart({ a, b }) {
  const W = Dimensions.get('window').width - 64, Ht = 110, all = a.concat(b), lo = Math.min(...all), hi = Math.max(...all);
  const pts = s => s.map((v, i) => `${(i / (s.length - 1) * W).toFixed(1)},${(Ht - (v - lo) / (hi - lo || 1) * Ht).toFixed(1)}`).join(' ');
  return <Svg width={W} height={Ht} style={{ marginTop: 8 }}><Polyline points={pts(b)} stroke={C.mu} strokeWidth="1.5" fill="none" /><Polyline points={pts(a)} stroke={C.ac} strokeWidth="2" fill="none" /></Svg>;
}

// ---------- Backtest tab ----------
function BT({ cfg, setCfg, cred }) {
  const [sym, setSym] = useState('SPY,QQQ'), [oos, setOos] = useState(false), [res, setRes] = useState([]), [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const set = (k, v) => setCfg({ ...cfg, [k]: v });
  const run = async () => {
    setBusy(true); setErr(''); setRes([]);
    try {
      const out = [];
      for (const s of sym.toUpperCase().split(',').map(x => x.trim()).filter(Boolean)) {
        const p = await getBars(s, cfg.start, cred);
        out.push({ s, ...backtest(p, cfg, oos ? Math.floor(p.length * 0.7) : 1) });
      }
      setRes(out);
    } catch (e) { setErr(String(e.message || e)); }
    setBusy(false);
  };
  return (
    <ScrollView contentContainerStyle={{ padding: 16 }} keyboardShouldPersistTaps="handled">
      <Card>
        <H t="Strategy" />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 8 }}>
          {Object.keys(PRESETS).map(k => <TouchableOpacity key={k} onPress={() => setCfg({ ...cfg, ...PRESETS[k] })} style={{ borderWidth: 1, borderColor: C.bd, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6, marginRight: 6 }}><Text style={{ color: C.tx }}>{k}</Text></TouchableOpacity>)}
        </ScrollView>
        <Lb t="Entry rules (all must be true, one per line)" /><In multiline value={cfg.entry} onChangeText={v => set('entry', v)} style={{ minHeight: 60 }} />
        <Lb t="Exit rules (any one exits)" /><In multiline value={cfg.exit} onChangeText={v => set('exit', v)} style={{ minHeight: 44 }} />
        <Text style={{ color: C.mu, fontSize: 11, marginTop: 6 }}>Indicators: Close, SMA(n), EMA(n), RSI(n), BBU(n,k), BBL(n,k), HIGH(n), LOW(n), ROC(n), MACD(f,s), MACDSIG(f,s,g). Operators: &gt; &lt; &gt;= &lt;= crosses_above crosses_below. Numbers work too: RSI(14) &lt; 30.</Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {[['sl', 'Stop %'], ['tp', 'Target %'], ['ts', 'Trail %'], ['size', 'Size %']].map(([k, l]) => <View key={k} style={{ flex: 1 }}><Lb t={l} /><In keyboardType="numeric" value={String(cfg[k])} onChangeText={v => set(k, v)} /></View>)}
        </View>
        <Lb t="Tickers (comma separated)" /><In value={sym} onChangeText={setSym} />
        <Lb t="Start date" /><In value={cfg.start} onChangeText={v => set('start', v)} />
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8 }}><Switch value={oos} onValueChange={setOos} /><Text style={{ color: C.tx, marginLeft: 8 }}>Last 30% only (out-of-sample)</Text></View>
        <Btn t={busy ? 'Running...' : 'Run backtest'} on={run} dis={busy} />
        {busy && <ActivityIndicator color={C.ac} style={{ marginTop: 8 }} />}
        {!!err && <Text style={{ color: C.rd, marginTop: 8 }}>{err}</Text>}
      </Card>
      {res.map(r => (
        <Card key={r.s}>
          <H t={r.s} />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 6 }}>
            {[['Strategy %', r.m.ret, col(r.m.ret)], ['Buy & hold %', r.m.bh, col(r.m.bh)], ['Max drawdown %', -r.m.dd, C.rd], ['Sharpe', r.m.sharpe, C.tx], ['Trades', r.m.trades, C.tx], ['Win rate %', r.m.win, C.tx]].map(([l, v, c]) => <View key={l} style={{ width: '33%', marginBottom: 6 }}><Text style={{ color: C.mu, fontSize: 11 }}>{l}</Text><Text style={{ color: c, fontSize: 16, fontWeight: '700' }}>{f(v, l === 'Trades' ? 0 : 1)}</Text></View>)}
          </View>
          <Chart a={r.eq} b={r.bh} />
          <Text style={{ color: C.mu, fontSize: 12, marginTop: 6 }}>Blue: strategy. Gray: buy and hold. {r.m.ret > r.m.bh ? 'Beat the market here.' : 'Did not beat the market here.'}</Text>
        </Card>
      ))}
    </ScrollView>
  );
}

// ---------- Trade tab ----------
function Trade({ cfg, cred }) {
  const [acct, setAcct] = useState(null), [pos, setPos] = useState([]), [sym, setSym] = useState('SPY'), [amt, setAmt] = useState('100'), [sig, setSig] = useState(null), [msg, setMsg] = useState(''), [busy, setBusy] = useState(false);
  const guard = async fn => { setBusy(true); setMsg(''); try { await fn(); } catch (e) { setMsg(String(e.message || e)); } setBusy(false); };
  const refresh = () => guard(async () => { setAcct(await api(cred, '/account')); setPos(await api(cred, '/positions')); });
  const confirm = (title, fn) => Alert.alert(cred.live ? 'LIVE - REAL MONEY' : 'Paper order', title, [{ text: 'Cancel', style: 'cancel' }, { text: 'Confirm', style: cred.live ? 'destructive' : 'default', onPress: () => guard(async () => { await fn(); setMsg('Done.'); setAcct(await api(cred, '/account')); setPos(await api(cred, '/positions')); }) }]);
  const S = sym.trim().toUpperCase();
  const buy = () => confirm(`Buy $${amt} of ${S}?`, () => api(cred, '/orders', 'POST', { symbol: S, notional: String(+amt), side: 'buy', type: 'market', time_in_force: 'day' }));
  const close = s => confirm(`Close the whole ${s} position?`, () => api(cred, '/positions/' + s, 'DELETE'));
  const check = () => guard(async () => { const p = await getBars(S, cfg.start, cred); const r = backtest(p, cfg, 1); setSig({ s: S, holding: r.holding, have: pos.some(x => x.symbol === S) }); });
  const act = sig && sig.holding !== sig.have;
  return (
    <ScrollView contentContainerStyle={{ padding: 16 }} keyboardShouldPersistTaps="handled">
      <Card>
        <H t={cred.live ? 'LIVE account (real money)' : 'Paper account'} />
        {acct && <Text style={{ color: C.tx, marginTop: 6 }}>Equity ${(+acct.equity).toFixed(2)}   Buying power ${(+acct.buying_power).toFixed(2)}</Text>}
        <Btn t="Refresh account" on={refresh} dis={busy || !cred.k} c={C.bd} />
        {pos.map(x => <View key={x.symbol} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}><Text style={{ color: C.tx }}>{x.symbol}  {x.qty} sh</Text><Text style={{ color: col(+x.unrealized_pl) }}>{(+x.unrealized_pl).toFixed(2)}</Text><TouchableOpacity onPress={() => close(x.symbol)}><Text style={{ color: C.rd }}>Close</Text></TouchableOpacity></View>)}
      </Card>
      <Card>
        <H t="Order" />
        <Lb t="Ticker" /><In value={sym} onChangeText={setSym} />
        <Lb t="Amount in dollars" /><In keyboardType="numeric" value={amt} onChangeText={setAmt} />
        <Btn t="Buy" on={buy} dis={busy || !cred.k} c={C.gr} />
        <Btn t="Check strategy signal (uses Backtest tab rules)" on={check} dis={busy || !cred.k} c={C.bd} />
        {sig && <Text style={{ color: C.tx, marginTop: 8 }}>{sig.s}: strategy says {sig.holding ? 'LONG' : 'FLAT'}. You {sig.have ? 'hold it.' : 'do not hold it.'}</Text>}
        {act && sig.holding && <Btn t={`Buy $${amt} ${sig.s} per signal`} on={buy} c={C.gr} />}
        {act && !sig.holding && <Btn t={`Close ${sig.s} per signal`} on={() => close(sig.s)} c={C.rd} />}
        {!!msg && <Text style={{ color: msg === 'Done.' ? C.gr : C.rd, marginTop: 8 }}>{msg}</Text>}
        {busy && <ActivityIndicator color={C.ac} style={{ marginTop: 8 }} />}
      </Card>
      <Text style={{ color: C.mu, fontSize: 12 }}>Every order asks for confirmation. Signals use the latest daily close; run the check after market close.</Text>
    </ScrollView>
  );
}

// ---------- Settings tab ----------
function Settings({ user, cred, setCred, logout }) {
  const [k, setK] = useState(cred.k), [s, setS] = useState(cred.s), [t, setT] = useState('');
  const save = async () => { await SecureStore.setItemAsync('akey', k.trim()); await SecureStore.setItemAsync('asec', s.trim()); setCred({ ...cred, k: k.trim(), s: s.trim() }); Alert.alert('Saved', 'Keys stored in the secure keystore.'); };
  return (
    <ScrollView contentContainerStyle={{ padding: 16 }} keyboardShouldPersistTaps="handled">
      <Card>
        <H t={'Signed in as ' + user} />
        <Lb t="Alpaca API key ID" /><In value={k} onChangeText={setK} />
        <Lb t="Alpaca secret key" /><In value={s} onChangeText={setS} secureTextEntry />
        <Btn t="Save keys" on={save} />
      </Card>
      <Card>
        <H t={cred.live ? 'Live trading is ON' : 'Paper trading (safe mode)'} />
        <Text style={{ color: C.mu, marginTop: 4 }}>Live trading is off every time the app starts. To enable it, type LIVE.</Text>
        {cred.live ? <Btn t="Switch back to paper" on={() => setCred({ ...cred, live: false })} />
          : <><In placeholder="type LIVE" value={t} onChangeText={setT} /><Btn t="Enable live trading" c={C.rd} dis={t !== 'LIVE'} on={() => { setCred({ ...cred, live: true }); setT(''); }} /></>}
      </Card>
      <Btn t="Sign out" on={logout} c={C.bd} />
      <Text style={{ color: C.mu, fontSize: 12, marginTop: 12 }}>For learning only. Not financial advice. Past backtests do not predict future results.</Text>
    </ScrollView>
  );
}

// ---------- shell ----------
function Main({ user, cred, setCred, logout }) {
  const [tab, setTab] = useState('bt'), [cfg, setCfg] = useState({ ...PRESETS['SMA cross'], sl: '', tp: '', ts: '', size: '100', start: '2018-01-01' });
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1 }}>
        {tab === 'bt' && <BT cfg={cfg} setCfg={setCfg} cred={cred} />}
        {tab === 'tr' && <Trade cfg={cfg} cred={cred} />}
        {tab === 'st' && <Settings user={user} cred={cred} setCred={setCred} logout={logout} />}
      </View>
      <View style={{ flexDirection: 'row', borderTopWidth: 1, borderColor: C.bd, backgroundColor: C.cd }}>
        {[['bt', 'Backtest'], ['tr', cred.live ? 'Trade (LIVE)' : 'Trade'], ['st', 'Settings']].map(([k, l]) => <TouchableOpacity key={k} onPress={() => setTab(k)} style={{ flex: 1, padding: 14, alignItems: 'center' }}><Text style={{ color: tab === k ? C.ac : C.mu, fontWeight: tab === k ? '700' : '400' }}>{l}</Text></TouchableOpacity>)}
      </View>
    </View>
  );
}

export default function App() {
  const [ready, setReady] = useState(false), [acct, setAcct] = useState(null), [authed, setAuthed] = useState(false), [cred, setCred] = useState({ k: '', s: '', live: false });
  useEffect(() => { (async () => { const a = await SecureStore.getItemAsync('acct'); if (a) setAcct(JSON.parse(a)); setCred({ k: (await SecureStore.getItemAsync('akey')) || '', s: (await SecureStore.getItemAsync('asec')) || '', live: false }); setReady(true); })(); }, []);
  useEffect(() => { const sub = AppState.addEventListener('change', st => { if (st === 'background') { setAuthed(false); setCred(c => ({ ...c, live: false })); } }); return () => sub.remove(); }, []);
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
      <StatusBar style="light" />
      {!ready ? <ActivityIndicator color={C.ac} style={{ marginTop: 100 }} />
        : !authed ? <Auth acct={acct} onOk={a => { setAcct(a); setAuthed(true); }} />
        : <Main user={acct.user} cred={cred} setCred={setCred} logout={() => setAuthed(false)} />}
    </SafeAreaView>
  );
}
