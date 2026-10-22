// Text/voice command interpreter shared by SMS and the phone hotline.
import { one, all, run, now } from './db.js';
import { verifySecret } from './crypto.js';
import { accountSummary, placeOrder, lastPrice } from './brokers.js';
import { nextRunAfter } from './scheduler.js';

export const HELP = `QuantPocket commands:
BAL - balance   POS - positions   PRICE AAPL
BUY 5 AAPL 1234   SELL 5 AAPL 1234   BUY $100 AAPL 1234
(last number is your PIN; add LIVE to use Alpaca)
DCA $50 SPY WEEKLY 1234 - scheduled buy
ORDERS - scheduled trades   CANCEL 7 1234
BOTS - auto strategies   PAUSE 1234 - stop all bots & schedules`;

const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twenty: 20, fifty: 50, hundred: 100 };
const NAMES = { apple: 'AAPL', microsoft: 'MSFT', tesla: 'TSLA', amazon: 'AMZN', google: 'GOOGL', nvidia: 'NVDA', meta: 'META', 's&p': 'SPY', spy: 'SPY', qqq: 'QQQ' };
const money = x => '$' + (+x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function normalize(text) {
  return String(text || '').toLowerCase().replace(/[.,!?]/g, ' ').split(/\s+/).filter(Boolean)
    .filter(w => !['shares', 'share', 'of', 'please', 'dollars', 'worth', 'stock', 'my', 'pin', 'is'].includes(w))
    .map(w => WORDS[w] ?? NAMES[w] ?? w).join(' ').toUpperCase();
}

// pinVerified lets the voice hotline (which checks the PIN up front) skip the trailing PIN.
export async function handleCommand(user, text, { pinVerified = false } = {}) {
  const t = normalize(text).split(' ');
  const cmd = t[0];
  const live = t.includes('LIVE');
  const args = t.filter(x => x !== 'LIVE');
  const account = live ? 'alpaca' : 'paper';
  const pinOk = () => pinVerified || (user.pin_hash && verifySecret(args[args.length - 1], user.pin_hash));
  const needPin = 'That needs your PIN at the end. Set one in Settings > Phone.';

  switch (cmd) {
    case 'HELP': case 'MENU': case '?': return HELP;
    case 'BAL': case 'BALANCE': {
      const s = await accountSummary(user.id, account);
      return `${live ? 'Alpaca' : 'Paper'}: equity ${money(s.equity)}, cash ${money(s.cash)}`;
    }
    case 'POS': case 'POSITIONS': {
      const s = await accountSummary(user.id, account);
      return s.positions.length ? s.positions.map(p => `${p.symbol} ${p.qty} @ ${money(p.price)} (${p.pnl >= 0 ? '+' : ''}${money(p.pnl)})`).join('\n') : 'No positions.';
    }
    case 'PRICE': case 'QUOTE': {
      if (!args[1]) return 'Usage: PRICE AAPL';
      return `${args[1]} ${money(await lastPrice(args[1], user.id))}`;
    }
    case 'BUY': case 'SELL': {
      if (!pinOk()) return needPin;
      const [, amt, sym] = args;
      if (!amt || !sym) return 'Usage: BUY 5 AAPL 1234 or BUY $100 AAPL 1234';
      const order = amt.startsWith('$') ? { notional: +amt.slice(1) } : { qty: +amt };
      const r = await placeOrder(user.id, account, { ...order, symbol: sym, side: cmd.toLowerCase() }, 'sms');
      return `${r.side.toUpperCase()} ${r.symbol}: ${r.status}${r.price ? ' @ ' + money(r.price) : ''} (${r.broker})`;
    }
    case 'DCA': {
      if (!pinOk()) return needPin;
      const [, amt, sym, freq = 'WEEKLY'] = args;
      const repeat = { DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly' }[freq] || 'weekly';
      if (!amt?.startsWith('$') || !sym) return 'Usage: DCA $50 SPY WEEKLY 1234';
      const r = await run('INSERT INTO scheduled_orders (user_id, account, symbol, side, notional, repeat, next_run, created_at) VALUES (?,?,?,?,?,?,?,?)',
        user.id, account, sym, 'buy', +amt.slice(1), repeat, nextRunAfter(now(), 'daily'), now());
      return `Scheduled #${r.lastInsertRowid}: buy ${amt} ${sym} ${repeat}.`;
    }
    case 'ORDERS': {
      const rows = await all('SELECT * FROM scheduled_orders WHERE user_id = ? AND active = 1', user.id);
      return rows.length ? rows.map(o => `#${o.id} ${o.side} ${o.qty ?? '$' + o.notional} ${o.symbol} ${o.repeat} next ${new Date(o.next_run).toISOString().slice(0, 16)}Z`).join('\n') : 'No scheduled trades.';
    }
    case 'CANCEL': {
      if (!pinOk()) return needPin;
      const r = await run('UPDATE scheduled_orders SET active = 0 WHERE id = ? AND user_id = ?', +args[1], user.id);
      return r.changes ? `Cancelled #${args[1]}.` : 'Not found.';
    }
    case 'BOTS': {
      const rows = await all('SELECT id, name, symbol, deployed, last_action FROM strategies WHERE user_id = ? AND deployed IS NOT NULL', user.id);
      return rows.length ? rows.map(b => `#${b.id} ${b.name} ${b.symbol} on ${b.deployed}${b.last_action ? ' - ' + b.last_action : ''}`).join('\n') : 'No bots running.';
    }
    case 'PAUSE': {
      if (!pinOk()) return needPin;
      await run('UPDATE strategies SET deployed = NULL WHERE user_id = ?', user.id);
      await run('UPDATE scheduled_orders SET active = 0 WHERE user_id = ?', user.id);
      return 'All bots and scheduled trades paused.';
    }
    default: return 'Unknown command. Text HELP for the list.';
  }
}

export const userByPhone = phone => one('SELECT * FROM users WHERE phone = ? AND phone_verified = 1', phone);
