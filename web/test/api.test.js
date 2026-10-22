// End-to-end API flow against an in-memory database, with no external services.
const { test, before, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { app } = await import('../server.js');
const { totp } = await import('../src/crypto.js');
const { run } = await import('../src/db.js');

let server, base, cookie = '';
before(() => new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
after(() => server.close());

async function call(path, body, method) {
  const r = await fetch(base + '/api' + path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'qp', cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
  return { status: r.status, body: await r.json().catch(() => null) };
}

test('register, trade, schedule, tax, 2FA login', async () => {
  assert.equal((await call('/auth/register', { email: 'a@b.co', password: 'short' })).status, 400);
  const reg = await call('/auth/register', { email: 'a@b.co', password: 'Str0ngPassword' });
  assert.equal(reg.body.user.role, 'admin');

  const csrf = await fetch(base + '/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: '{}' });
  assert.equal(csrf.status, 403);

  const bt = await call('/backtest', { symbol: 'SPY', entry: 'SMA(20) crosses_above SMA(100)', exit: 'SMA(20) crosses_below SMA(100)' });
  assert.equal(bt.body.source, 'synthetic');
  assert.ok(bt.body.projection.median !== undefined);

  const buy = await call('/orders', { account: 'paper', symbol: 'SPY', side: 'buy', qty: 10 });
  assert.equal(buy.body.status, 'filled');
  const sell = await call('/orders', { account: 'paper', symbol: 'SPY', side: 'sell', qty: 4 });
  assert.equal(sell.body.status, 'filled');
  assert.equal((await call('/orders', { account: 'paper', symbol: 'SPY', side: 'sell', qty: 100 })).status, 400);

  const acct = await call('/account?account=paper');
  assert.equal(acct.body.positions[0].qty, 6);

  const tax = await call('/tax?account=paper');
  assert.equal(tax.body.rows.length, 1);

  const sch = await call('/schedule', { account: 'paper', symbol: 'QQQ', side: 'buy', notional: 50, repeat: 'weekly', at: new Date(Date.now() + 60e3).toISOString() });
  assert.ok(sch.body.id);

  const cmd = await call('/command', { text: 'BAL' });
  assert.match(cmd.body.reply, /^Paper: equity \$/);
  assert.match((await call('/command', { text: 'BUY 1 SPY 9999' })).body.reply, /PIN/);

  const ph = await call('/phone', { phone: '+17185551234' });
  assert.equal((await call('/phone/verify', { code: ph.body.devCode })).status, 200);

  const setup = await call('/auth/totp/setup', {});
  assert.equal((await call('/auth/totp/enable', { code: totp(setup.body.secret) })).status, 200);
  await call('/auth/logout', {});
  const login = await call('/auth/login', { email: 'a@b.co', password: 'Str0ngPassword' });
  assert.equal(login.body.mfaRequired, true);
  assert.equal((await call('/account')).status, 401);
  assert.equal((await call('/auth/mfa', { code: '000000' })).status, 401);
  assert.equal((await call('/auth/mfa', { code: totp(setup.body.secret) })).status, 200);
  assert.equal((await call('/account')).status, 200);

  run("UPDATE paper_accounts SET cash = cash + 5000 WHERE user_id = 1");
  const fees = await call('/admin/assess-fees', {});
  assert.ok(fees.body.find(f => f.account === 'paper').fee > 0);
});

test('lockout after repeated bad passwords', async () => {
  await call('/auth/register', { email: 'c@d.co', password: 'Str0ngPassword' });
  for (let i = 0; i < 5; i++) await call('/auth/login', { email: 'c@d.co', password: 'wrongWrong1' });
  assert.equal((await call('/auth/login', { email: 'c@d.co', password: 'Str0ngPassword' })).status, 423);
});

test('password reset, email verification, export and delete', async () => {
  cookie = '';
  const { one } = await import('../src/db.js');
  const { sha256 } = await import('../src/crypto.js');
  await call('/auth/register', { email: 'r@s.co', password: 'Str0ngPassword' });
  const u = await one('SELECT * FROM users WHERE email = ?', 'r@s.co');
  assert.ok(u.verify_hash);
  // Tokens are stored hashed; plant a known one to exercise the endpoints.
  await run('UPDATE users SET verify_hash = ? WHERE id = ?', sha256('vtok'), u.id);
  assert.equal((await call('/auth/verify', { token: 'vtok' })).status, 200);
  assert.equal((await call('/auth/me')).body.user.emailVerified, true);

  assert.equal((await call('/auth/forgot', { email: 'nobody@x.co' })).body.ok, true);
  await call('/auth/forgot', { email: 'r@s.co' });
  await run('UPDATE users SET reset_hash = ? WHERE id = ?', sha256('rtok'), u.id);
  assert.equal((await call('/auth/reset', { token: 'rtok', password: 'N3wPasswordXyz' })).status, 200);
  assert.equal((await call('/auth/me')).body.user, null); // all sessions revoked
  assert.equal((await call('/auth/reset', { token: 'rtok', password: 'N3wPasswordXyz' })).status, 400);
  assert.equal((await call('/auth/login', { email: 'r@s.co', password: 'N3wPasswordXyz' })).status, 200);

  const exp = await fetch(base + '/api/auth/export', { headers: { cookie } });
  assert.match(exp.headers.get('content-disposition'), /attachment/);
  assert.equal((await exp.json()).profile.email, 'r@s.co');
  assert.equal((await call('/auth/delete', { password: 'wrong' })).status, 401);
  assert.equal((await call('/auth/delete', { password: 'N3wPasswordXyz' })).status, 200);
  assert.equal(await one('SELECT id FROM users WHERE email = ?', 'r@s.co'), undefined);
});

test('public demo, contact, health and cron tick', async () => {
  const demo = await call('/public/backtest', { symbol: 'QQQ', preset: 'Breakout' });
  assert.equal(demo.status, 200);
  assert.ok(demo.body.curve.length > 10);
  assert.equal((await call('/public/contact', { email: 'bad', body: 'x' })).status, 400);
  assert.equal((await call('/public/contact', { email: 'a@b.co', body: 'Hi' })).status, 200);
  const pre = await fetch(base + '/api/public/backtest', { method: 'OPTIONS', headers: { Origin: 'https://aryebleich.github.io' } });
  assert.equal(pre.headers.get('access-control-allow-origin'), 'https://aryebleich.github.io');
  assert.equal((await fetch(base + '/healthz')).status, 200);
  assert.equal((await fetch(base + '/internal/tick', { method: 'POST' })).status, 401);
  process.env.CRON_SECRET = 's3cret';
  const tick = await fetch(base + '/internal/tick', { method: 'POST', headers: { Authorization: 'Bearer s3cret' } });
  assert.equal(tick.status, 200);
  assert.equal((await fetch(base + '/no-such-page')).status, 404);
});
