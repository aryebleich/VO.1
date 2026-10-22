// Revenue: monthly plans + performance fee on new profits above a high-water mark.
import { one, all, run, now } from './db.js';

export const PLANS = {
  free: { name: 'Starter', monthly: 0, perfFee: 0.20, features: ['Paper trading', 'Backtests (5 years)', 'SMS balance & quotes'] },
  pro: { name: 'Pro', monthly: 29, perfFee: 0.10, features: ['Live trading via Alpaca', 'Scheduled trades', 'Auto-trading bots', 'QuantConnect cloud backtests', 'Full SMS + voice hotline'] },
  elite: { name: 'Elite', monthly: 99, perfFee: 0.05, features: ['Everything in Pro', 'Optimizer + walk-forward', 'AI strategy builder priority', 'Tax-loss harvesting report'] },
};

// Fee = rate x (equity - high-water mark), where the HWM moves with deposits/withdrawals so
// users never pay on their own contributions or on recovering an earlier loss.
export function computePerformanceFee({ equity, highWater, rate }) {
  const gain = equity - highWater;
  return gain > 0 ? { fee: +(gain * rate).toFixed(2), gain: +gain.toFixed(2), newHighWater: equity - gain * rate } : { fee: 0, gain: 0, newHighWater: highWater };
}

export async function adjustForCashflow(userId, account, amount) {
  const s = await one('SELECT * FROM fee_state WHERE user_id = ? AND account = ?', userId, account);
  if (!s) await run('INSERT INTO fee_state (user_id, account, high_water, net_contrib) VALUES (?,?,?,?)', userId, account, Math.max(amount, 0), amount);
  else await run('UPDATE fee_state SET high_water = high_water + ?, net_contrib = net_contrib + ? WHERE user_id = ? AND account = ?', amount, amount, userId, account);
}

// Charge one account; records the fee in the ledger and raises the high-water mark.
export async function assessFee(userId, account, equity) {
  const u = await one('SELECT plan FROM users WHERE id = ?', userId);
  const rate = PLANS[u.plan]?.perfFee ?? PLANS.free.perfFee;
  let s = await one('SELECT * FROM fee_state WHERE user_id = ? AND account = ?', userId, account);
  if (!s) { await run('INSERT INTO fee_state (user_id, account, high_water, net_contrib) VALUES (?,?,?,?)', userId, account, equity, equity); return { fee: 0, initialized: true }; }
  const r = computePerformanceFee({ equity, highWater: s.high_water, rate });
  if (r.fee > 0) {
    await run('UPDATE fee_state SET high_water = ? WHERE user_id = ? AND account = ?', r.newHighWater, userId, account);
    await run('INSERT INTO ledger (user_id, kind, amount, status, memo, at) VALUES (?,?,?,?,?,?)', userId, 'performance_fee', r.fee,
      account === 'paper' ? 'simulated' : 'due', `${(rate * 100).toFixed(0)}% of $${r.gain} new profit on ${account}`, now());
    if (account === 'paper') await run('UPDATE paper_accounts SET cash = cash - ? WHERE user_id = ?', r.fee, userId);
  }
  return { ...r, rate };
}

export async function revenueSummary() {
  const byKind = await all("SELECT kind, status, COUNT(*) n, ROUND(SUM(amount), 2) total FROM ledger WHERE kind IN ('performance_fee','subscription') GROUP BY kind, status");
  const plans = await all('SELECT plan, COUNT(*) n FROM users GROUP BY plan');
  const mrr = plans.reduce((a, p) => a + (PLANS[p.plan]?.monthly || 0) * p.n, 0);
  return { byKind, plans, mrr, users: (await one('SELECT COUNT(*) n FROM users')).n };
}
