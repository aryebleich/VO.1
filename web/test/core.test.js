import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backtest, projectAnnual, walkForward, optimize, warmupFor, latestSignal, compile } from '../src/engine.js';
import { computePerformanceFee } from '../src/fees.js';
import { realizedGains, taxSummary, form8949Csv } from '../src/tax.js';
import { totp, verifyTotp, base32Encode, base32Decode, encrypt, decrypt, hashSecret, verifySecret } from '../src/crypto.js';
import { syntheticBars } from '../src/brokers.js';
import { heuristic } from '../src/ai.js';
import { normalize } from '../src/commands.js';
import { nextRunAfter } from '../src/scheduler.js';

const DAY = 86400e3;

test('backtest: buy-and-hold rule tracks the price with costs', () => {
  const p = Array.from({ length: 300 }, (_, i) => 100 + i);
  const r = backtest(p, { entry: 'Close > 0', exit: '', cost: 0 }, 1);
  assert.equal(r.m.trades, 0);
  assert.ok(r.holding);
  assert.ok(Math.abs(r.eq.at(-1) - 1e4 * p.at(-1) / p[1]) < 1e-6);
});

test('backtest: stop loss closes the trade', () => {
  const p = [100, 100, 100, 90, 80, 80];
  const r = backtest(p, { entry: 'Close > 0', exit: '', sl: 5, cost: 0 }, 1);
  assert.equal(r.trades[0].reason, 'stop loss');
  assert.equal(r.trades[0].exit, 90);
});

test('compile rejects unknown indicators', () => {
  assert.throws(() => compile('FOO(3) > 1', [1, 2, 3]), /Unknown indicator/);
});

test('projection, walk-forward and optimizer return sane shapes', () => {
  const { closes, dates } = syntheticBars('TEST');
  const cfg = { entry: 'SMA(20) crosses_above SMA(100)', exit: 'SMA(20) crosses_below SMA(100)' };
  const r = backtest(closes, cfg, warmupFor(cfg), closes.length, dates);
  const p = projectAnnual(r.eq);
  assert.ok(p.p5 <= p.median && p.median <= p.p95);
  assert.equal(walkForward(closes, cfg, 101, 4, dates).folds.length, 4);
  const o = optimize(closes, { entry: 'SMA({10,20}) crosses_above SMA({100,200})', exit: 'SMA(20) crosses_below SMA(100)' }, 201, dates);
  assert.equal(o.runs, 4);
  assert.equal(typeof latestSignal(closes, cfg).enter, 'boolean');
});

test('performance fee only charges above the high-water mark', () => {
  assert.deepEqual(computePerformanceFee({ equity: 9000, highWater: 10000, rate: 0.2 }), { fee: 0, gain: 0, newHighWater: 10000 });
  const r = computePerformanceFee({ equity: 12000, highWater: 10000, rate: 0.2 });
  assert.equal(r.fee, 400);
  assert.equal(r.newHighWater, 11600);
});

test('tax: FIFO lots, long/short term and wash sales', () => {
  const t0 = Date.UTC(2024, 0, 2);
  const fills = [
    { symbol: 'A', side: 'buy', qty: 10, price: 10, at: t0 },
    { symbol: 'A', side: 'buy', qty: 10, price: 20, at: t0 + 400 * DAY },
    { symbol: 'A', side: 'sell', qty: 15, price: 30, at: t0 + 410 * DAY },
    { symbol: 'B', side: 'buy', qty: 1, price: 100, at: t0 + 400 * DAY },
    { symbol: 'B', side: 'sell', qty: 1, price: 80, at: t0 + 405 * DAY },
    { symbol: 'B', side: 'buy', qty: 1, price: 81, at: t0 + 420 * DAY },
  ];
  const rows = realizedGains(fills);
  assert.deepEqual(rows.filter(r => r.symbol === 'A').map(r => [r.qty, r.gain, r.longTerm]), [[10, 200, true], [5, 50, false]]);
  assert.equal(rows.find(r => r.symbol === 'B').washSale, true);
  const s = taxSummary(fills, { year: 2025, bracket: 0.24, stateRate: 0 });
  assert.equal(s.longTerm, 200);
  assert.equal(s.shortTerm, 50);
  assert.equal(s.washSaleDisallowed, 20);
  assert.equal(s.estimatedTax, 50 * 0.24 + 200 * 0.15);
  assert.match(form8949Csv(s.rows), /,W,20,0,Short/);
});

test('crypto: TOTP matches RFC 6238 vector, AES round trip, scrypt', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(base32Decode(secret).toString(), '12345678901234567890');
  assert.equal(totp(secret, 59e3), '287082');
  assert.ok(verifyTotp(secret, totp(secret)));
  assert.deepEqual(decrypt(encrypt({ k: 'a', s: 'b' })), { k: 'a', s: 'b' });
  const h = hashSecret('1234');
  assert.ok(verifySecret('1234', h) && !verifySecret('4321', h));
});

test('AI keyword builder produces runnable rules', () => {
  const r = heuristic('Buy AAPL when RSI below 25 in an uptrend with a 7% stop loss');
  assert.equal(r.symbol, 'AAPL');
  assert.equal(r.entry, 'RSI(14) < 25\nClose > SMA(200)');
  assert.equal(r.stopLoss, 7);
});

test('voice/SMS normalizer understands spoken orders', () => {
  assert.equal(normalize('Buy five shares of Apple'), 'BUY 5 AAPL');
});

test('schedule skips weekends', () => {
  const fri = Date.UTC(2026, 9, 23, 15);
  assert.equal(new Date(nextRunAfter(fri, 'daily')).getUTCDay(), 1);
  assert.equal(nextRunAfter(fri, 'once'), null);
});
