// QuantConnect API v2 client: run LEAN algorithms (Python/C#) in QuantConnect's cloud.
// Auth: Basic base64(userId:sha256(token:timestamp)) plus a Timestamp header.
import crypto from 'node:crypto';

const BASE = 'https://www.quantconnect.com/api/v2';

export async function qc(cred, path, body = {}) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const hash = crypto.createHash('sha256').update(`${cred.token}:${ts}`).digest('hex');
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${cred.userId}:${hash}`).toString('base64'), Timestamp: ts, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({ success: false, errors: [`HTTP ${r.status}`] }));
  if (!d.success) throw new Error('QuantConnect: ' + (d.errors || []).join('; '));
  return d;
}

// Starter LEAN algorithms users can push to a new QuantConnect project.
export const TEMPLATES = {
  'Dual momentum rotation': `# region imports
from AlgorithmImports import *
# endregion

class DualMomentum(QCAlgorithm):
    def initialize(self):
        self.set_start_date(2015, 1, 1)
        self.set_cash(100000)
        self.assets = [self.add_equity(t, Resolution.DAILY).symbol for t in ["SPY", "EFA", "IEF"]]
        self.mom = {s: self.momp(s, 252, Resolution.DAILY) for s in self.assets}
        self.set_warm_up(252)
        self.schedule.on(self.date_rules.month_start("SPY"), self.time_rules.after_market_open("SPY", 30), self.rebalance)

    def rebalance(self):
        if self.is_warming_up: return
        spy, efa, ief = self.assets
        best = spy if self.mom[spy].current.value > self.mom[efa].current.value else efa
        target = best if self.mom[best].current.value > 0 else ief
        for s in self.assets:
            self.set_holdings(s, 1.0 if s == target else 0.0)
`,
  'Mean reversion (RSI-2)': `# region imports
from AlgorithmImports import *
# endregion

class Rsi2(QCAlgorithm):
    def initialize(self):
        self.set_start_date(2015, 1, 1)
        self.set_cash(100000)
        self.spy = self.add_equity("SPY", Resolution.DAILY).symbol
        self.rsi = self.rsi(self.spy, 2, MovingAverageType.WILDERS, Resolution.DAILY)
        self.trend = self.sma(self.spy, 200, Resolution.DAILY)
        self.set_warm_up(200)

    def on_data(self, data):
        if self.is_warming_up or not data.contains_key(self.spy): return
        price = self.securities[self.spy].price
        if not self.portfolio.invested and self.rsi.current.value < 10 and price > self.trend.current.value:
            self.set_holdings(self.spy, 1)
        elif self.portfolio.invested and self.rsi.current.value > 70:
            self.liquidate(self.spy)
`,
  'Equal-weight top-10 large caps (monthly)': `# region imports
from AlgorithmImports import *
# endregion

class TopTen(QCAlgorithm):
    def initialize(self):
        self.set_start_date(2018, 1, 1)
        self.set_cash(100000)
        self.universe_settings.resolution = Resolution.DAILY
        self.add_universe(self.select)
        self.set_portfolio_construction(EqualWeightingPortfolioConstructionModel(lambda t: Expiry.END_OF_MONTH))
        self.add_alpha(ConstantAlphaModel(InsightType.PRICE, InsightDirection.UP, timedelta(days=30)))
        self.set_execution(ImmediateExecutionModel())

    def select(self, fundamental):
        return [f.symbol for f in sorted([f for f in fundamental if f.has_fundamental_data and f.price > 5], key=lambda f: f.market_cap, reverse=True)[:10]]
`,
};

export const listProjects = c => qc(c, '/projects/read').then(d => d.projects.map(p => ({ id: p.projectId, name: p.name, language: p.language, modified: p.modified })));

export async function createProject(c, name, code) {
  const d = await qc(c, '/projects/create', { name, language: 'Py' });
  const id = d.projects[0].projectId;
  await qc(c, '/files/update', { projectId: id, name: 'main.py', content: code });
  return id;
}

// Compile, then start a cloud backtest. Compilation is asynchronous so we poll briefly.
export async function startBacktest(c, projectId, name) {
  const comp = await qc(c, '/compile/create', { projectId });
  let state = comp.state, tries = 0;
  while (state === 'InQueue' && tries++ < 20) {
    await new Promise(r => setTimeout(r, 1500));
    state = (await qc(c, '/compile/read', { projectId, compileId: comp.compileId })).state;
  }
  if (state !== 'BuildSuccess') throw new Error('Compile failed: ' + state + ' ' + (comp.logs || []).join('\n'));
  const bt = await qc(c, '/backtests/create', { projectId, compileId: comp.compileId, backtestName: name || 'QuantPocket run ' + new Date().toISOString() });
  return bt.backtest.backtestId;
}

export async function readBacktest(c, projectId, backtestId) {
  const b = (await qc(c, '/backtests/read', { projectId, backtestId })).backtest;
  return { id: b.backtestId, name: b.name, completed: b.completed, progress: b.progress, error: b.error, statistics: b.statistics || {}, runtimeStatistics: b.runtimeStatistics || {} };
}

export const listBacktests = (c, projectId) => qc(c, '/backtests/list', { projectId }).then(d => (d.backtests || []).map(b => ({ id: b.backtestId, name: b.name, completed: b.completed, created: b.created })));
export const listLive = c => qc(c, '/live/list', { status: 'Running' }).then(d => d.live || []);
