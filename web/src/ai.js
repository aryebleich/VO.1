// Plain-English strategy builder. Uses Claude when ANTHROPIC_API_KEY is set, otherwise a
// keyword parser that understands the common setups.
import Anthropic from '@anthropic-ai/sdk';
import { compile } from './engine.js';

const DSL_HELP = `Rules are one condition per line: <operand> <op> <operand>.
Ops: >, <, >=, <=, crosses_above, crosses_below. Entry lines are ANDed; exit lines are ORed.
Operands: Close, number, SMA(n), EMA(n), RSI(n), BBU(n,k), BBL(n,k), HIGH(n) (highest close of prior n bars), LOW(n), ROC(n) (% change over n bars), MACD(fast,slow), MACDSIG(fast,slow,signal).`;

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['name', 'symbol', 'entry', 'exit', 'stopLoss', 'takeProfit', 'trailingStop', 'explanation'],
  properties: {
    name: { type: 'string' }, symbol: { type: 'string' },
    entry: { type: 'string', description: 'Entry rules, newline separated' },
    exit: { type: 'string', description: 'Exit rules, newline separated' },
    stopLoss: { type: 'number', description: 'Percent, 0 for none' },
    takeProfit: { type: 'number', description: 'Percent, 0 for none' },
    trailingStop: { type: 'number', description: 'Percent, 0 for none' },
    explanation: { type: 'string' },
  },
};

let client;
async function viaClaude(prompt) {
  client ||= new Anthropic();
  const res = await client.beta.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system: `You turn a trader's idea into a long-only daily-bar strategy for a rule engine.\n${DSL_HELP}\nUse only those operands. If no ticker is given use SPY. Keep the explanation to two sentences and do not promise returns.`,
    messages: [{ role: 'user', content: prompt }],
  });
  if (res.stop_reason === 'refusal') throw new Error('The AI declined this request');
  const text = res.content.find(b => b.type === 'text')?.text;
  return JSON.parse(text);
}

const num = (s, re, d) => { const m = s.match(re); return m ? +m[1] : d; };
// Percent attached to a keyword in either order: "stop loss 7%" or "7% stop loss".
const pctFor = (s, word) => { const m = s.match(new RegExp(`(?:${word})\\D{0,10}(\\d+(?:\\.\\d+)?)\\s*%|(\\d+(?:\\.\\d+)?)\\s*%\\s*(?:${word})`)); return m ? +(m[1] ?? m[2]) : 0; };
export function heuristic(prompt) {
  const s = prompt.toLowerCase();
  const tick = prompt.match(/\b([A-Z]{1,5})\b/g)?.find(t => !['RSI', 'SMA', 'EMA', 'MACD', 'I', 'A', 'AND', 'OR'].includes(t)) || 'SPY';
  const out = { name: 'Custom idea', symbol: tick, entry: '', exit: '', stopLoss: pctFor(s, 'stop[- ]?loss|(?<!trailing )stop'), takeProfit: pctFor(s, 'take profit|target'), trailingStop: pctFor(s, 'trail'), explanation: '' };
  if (/rsi|oversold|overbought/.test(s)) {
    const lo = num(s, /(?:rsi\D{0,15}|below\s)(\d{1,2})\b/, 30);
    out.name = 'RSI reversion'; out.entry = `RSI(14) < ${lo}`; out.exit = 'RSI(14) > ' + num(s, /above\s(\d{2})/, 60);
    if (/trend|200/.test(s)) out.entry += '\nClose > SMA(200)';
  } else if (/macd/.test(s)) {
    out.name = 'MACD trend'; out.entry = 'MACD(12,26) crosses_above MACDSIG(12,26,9)'; out.exit = 'MACD(12,26) crosses_below MACDSIG(12,26,9)';
  } else if (/bollinger|band/.test(s)) {
    out.name = 'Bollinger reversion'; out.entry = 'Close < BBL(20,2)'; out.exit = 'Close > SMA(20)';
  } else if (/breakout|new high|52.?week/.test(s)) {
    const n = /52.?week/.test(s) ? 252 : num(s, /(\d+)[- ]day high/, 55);
    out.name = 'Breakout'; out.entry = `Close > HIGH(${n})`; out.exit = `Close < LOW(${Math.max(10, Math.round(n / 3))})`;
  } else if (/momentum/.test(s)) {
    out.name = 'Momentum'; out.entry = 'ROC(126) > 0\nClose > SMA(50)'; out.exit = 'ROC(126) < 0';
  } else {
    const [f, sl] = (s.match(/(\d+)\D+(\d+)/) || [0, 50, 200]).slice(1).map(Number);
    out.name = 'Moving-average cross'; out.entry = `SMA(${Math.min(f, sl)}) crosses_above SMA(${Math.max(f, sl)})`; out.exit = `SMA(${Math.min(f, sl)}) crosses_below SMA(${Math.max(f, sl)})`;
  }
  out.explanation = `Built from keywords in your description (${out.name}). Backtest it before using real money.`;
  return out;
}

export async function buildStrategy(prompt) {
  prompt = String(prompt || '').slice(0, 2000);
  let r, engine = 'keywords';
  if (process.env.ANTHROPIC_API_KEY) {
    try { r = await viaClaude(prompt); engine = 'claude'; } catch (e) { console.warn('AI builder fell back:', e.message); }
  }
  r ||= heuristic(prompt);
  // Validate against the engine so the UI never receives rules that cannot run.
  compile(r.entry, Array(300).fill(1)); compile(r.exit, Array(300).fill(1));
  return { ...r, symbol: r.symbol.toUpperCase(), engine };
}
