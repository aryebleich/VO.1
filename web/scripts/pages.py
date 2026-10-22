# Generates the static marketing pages in web/public from one shared layout.
# Run: python3 web/scripts/pages.py   (output is committed; the server just serves files)
import os, html
OUT = os.path.join(os.path.dirname(__file__), '..', 'public')
UPDATED = 'October 22, 2026'

def layout(title, desc, body, path=''):
    return f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title)}</title>
<meta name="description" content="{html.escape(desc)}">
<meta name="theme-color" content="#0b1324">
<link rel="icon" href="favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="icon-512.png">
<link rel="manifest" href="manifest.webmanifest">
<meta property="og:type" content="website">
<meta property="og:title" content="{html.escape(title)}">
<meta property="og:description" content="{html.escape(desc)}">
<meta property="og:image" content="og.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="stylesheet" href="site.css">
<script src="config.js"></script>
<script type="module" src="site.js"></script>
</head>
<body>
<header class="top"><div class="wrap">
  <a class="logo" href="./"><img src="favicon.svg" alt=""><b>Quant<span>Pocket</span></b></a>
  <nav class="links"><a href="./#features">Features</a><a href="./#demo">Live demo</a><a href="./#pricing">Pricing</a><a href="./#faq">FAQ</a><a href="contact.html">Contact</a></nav>
  <a class="btn ghost" data-app="#/login" href="app">Sign in</a>
  <a class="btn" data-app="#/register" href="app">Start free</a>
</div></header>
<main>
{body}
</main>
<footer class="site"><div class="wrap">
  <div class="cols">
    <div><a class="logo" href="./"><img src="favicon.svg" alt=""><b>Quant<span>Pocket</span></b></a><p style="max-width:300px">Research, test and automate stock strategies, from your browser, your phone, or a text message.</p></div>
    <div><b>Product</b><a href="./#features">Features</a><a href="./#pricing">Pricing</a><a href="./#demo">Live demo</a><a data-app="#/register" href="app">Create account</a></div>
    <div><b>Company</b><a href="contact.html">Contact &amp; support</a><a href="terms.html">Terms of Service</a><a href="privacy.html">Privacy Policy</a><a href="risk.html">Risk Disclosure</a></div>
  </div>
  <p class="disc">Investing involves risk, including possible loss of principal. Backtests and projections are hypothetical, are built with the benefit of hindsight and do not guarantee future results. QuantPocket is a software provider and is not a broker-dealer. Brokerage services are provided by Alpaca Securities LLC, member FINRA/SIPC, under your own account agreement with Alpaca. Nothing on this site is an offer, solicitation or recommendation to buy or sell any security. See the <a href="risk.html" style="display:inline">Risk Disclosure</a>.</p>
  <p class="disc">© 2026 QuantPocket. All rights reserved.</p>
</div></footer>
</body>
</html>
'''

ICON = {
 'chart': '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><path d="M7 14l4-4 3 3 5-6"/></svg>',
 'bolt': '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2 3 14h9l-1 8 10-12h-9z"/></svg>',
 'msg': '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
 'lock': '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
 'clock': '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>',
 'cube': '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8l-9-5-9 5v8l9 5z"/><path d="M3.3 7 12 12l8.7-5M12 22V12"/></svg>',
 'spark': '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z"/></svg>',
 'doc': '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/></svg>',
 'card': '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>',
}
FEATURES = [
 ('chart', 'Serious backtesting', 'Ten years of daily data, stops, trailing stops, costs, Sharpe, Sortino, drawdown, walk-forward checks and a parameter optimizer.'),
 ('spark', 'AI strategy builder', 'Describe an idea in plain English. Get precise, testable rules in seconds, then backtest them.'),
 ('cube', 'QuantConnect inside', 'Run full LEAN algorithms in Python in QuantConnect\'s cloud. Start from templates or bring your own code.'),
 ('bolt', 'Paper & live trading', 'Practice with $100,000 of paper money, then connect your own Alpaca account for live trading.'),
 ('clock', 'Bots & scheduled trades', 'Deploy strategies that act every trading day, schedule recurring buys, and get price alerts.'),
 ('msg', 'Trade by text or phone', 'Text BAL, POS or BUY 5 AAPL from your phone, or call the hotline and say it. Every trade is protected by your PIN.'),
 ('doc', 'Tax center', 'Realized gains by lot, short vs. long term, wash-sale flags, an estimated tax bill, harvesting ideas and Form 8949 export.'),
 ('lock', 'Bank-grade security', 'Two-factor login, encrypted API keys, session control, a full security log and account lockout.'),
 ('card', 'Simple funding', 'Add money with a debit card in seconds. A clear high-water-mark fee means you only pay when you make new profit.'),
]

def index():
    feats = ''.join(f'<div class="feature"><div class="ic">{ICON[i]}</div><h3>{t}</h3><p>{d}</p></div>' for i, t, d in FEATURES)
    body = f'''
<section class="hero"><div class="wrap">
  <h1>Turn trading ideas into tested, automated strategies.</h1>
  <p class="lead">Backtest with real market history, see the range of outcomes to expect, then run it on paper or with your Alpaca account. Manage everything from the web, by text message, or over the phone.</p>
  <div class="cta"><a class="btn light" data-app="#/register" href="app">Create a free account</a><a class="btn ghost" style="color:#fff;border-color:#40548a" href="#demo">Try the live demo</a></div>
  <p class="note">Free plan includes $100,000 in paper money. No card required.</p>
  <div class="logos"><span>Works with <b>Alpaca</b></span><span><b>QuantConnect</b> LEAN</span><span><b>Twilio</b> SMS &amp; voice</span><span>Payments by <b>Stripe</b></span></div>
</div></section>

<section id="features"><div class="wrap">
  <h2 class="sec">Everything you need to trade systematically</h2>
  <p class="sub">From the first idea to an automated strategy, with the honest numbers you need to decide.</p>
  <div class="features">{feats}</div>
</div></section>

<section class="alt" id="demo"><div class="wrap">
  <h2 class="sec">Live demo: test a strategy now</h2>
  <p class="sub">Pick a ticker and a classic strategy. It runs on the same engine as the app, using market data since 2015.</p>
  <div class="demo">
    <form id="demoForm">
      <label>Ticker<input name="symbol" value="SPY" maxlength="8" autocomplete="off"></label>
      <label>Strategy<select name="preset"><option>SMA cross</option><option>RSI dip in uptrend</option><option>Bollinger revert</option><option>Breakout</option><option>MACD trend</option><option>Momentum 12m</option></select></label>
      <button class="btn" style="margin-top:14px;width:100%">Run backtest</button>
      <div class="err" id="demoErr"></div>
      <p class="mu" style="font-size:13px" id="demoSrc"></p>
    </form>
    <div>
      <canvas id="demoChart" aria-label="Equity curve"></canvas>
      <div class="stats" id="demoStats"></div>
    </div>
  </div>
</div></section>

<section><div class="wrap">
  <h2 class="sec">How it works</h2>
  <p class="sub">Four steps from idea to automation.</p>
  <div class="steps">
    <div class="step"><h3>Describe or build</h3><p>Use presets, write rules, or describe your idea in plain English.</p></div>
    <div class="step"><h3>Backtest honestly</h3><p>See returns, drawdowns, out-of-sample results and a range of projected outcomes.</p></div>
    <div class="step"><h3>Practice on paper</h3><p>Run it as a bot on your paper account and watch how it behaves.</p></div>
    <div class="step"><h3>Go live, your way</h3><p>Connect Alpaca when you are ready. Pause any time, even by text message.</p></div>
  </div>
</div></section>

<section class="alt" id="pricing"><div class="wrap">
  <h2 class="sec">Simple, aligned pricing</h2>
  <p class="sub">A flat monthly plan plus a small share of new profits above your high-water mark. If your account is not at a new high, you pay no performance fee.</p>
  <div class="plans">
    <div class="plan"><h3>Starter</h3><div class="price">$0<small>/mo</small></div><p class="mu">+ 20% of new profits</p><ul><li>$100,000 paper account</li><li>Backtests &amp; AI builder</li><li>SMS balance and quotes</li><li>Tax center</li></ul><a class="btn ghost" data-app="#/register" href="app">Start free</a></div>
    <div class="plan best"><h3>Pro</h3><div class="price">$29<small>/mo</small></div><p class="mu">+ 10% of new profits</p><ul><li>Live trading with Alpaca</li><li>Bots and scheduled trades</li><li>QuantConnect cloud backtests</li><li>Full SMS and voice hotline</li></ul><a class="btn" data-app="#/register" href="app">Choose Pro</a></div>
    <div class="plan"><h3>Elite</h3><div class="price">$99<small>/mo</small></div><p class="mu">+ 5% of new profits</p><ul><li>Everything in Pro</li><li>Optimizer and walk-forward</li><li>Priority AI builder</li><li>Tax-loss harvesting report</li></ul><a class="btn ghost" data-app="#/register" href="app">Choose Elite</a></div>
  </div>
</div></section>

<section id="faq"><div class="wrap faq" style="max-width:820px">
  <h2 class="sec">Questions</h2>
  <details><summary>Will I make money?</summary><p>Nobody can promise that. Most active strategies underperform simply holding an index after costs. QuantPocket shows you how an idea behaved in the past, how it held up out of sample, and the range of outcomes to expect, so you can decide with your eyes open.</p></details>
  <details><summary>Who holds my money?</summary><p>Your brokerage account is opened and held by Alpaca Securities LLC, a FINRA/SIPC member. QuantPocket connects to it with API keys you control, and you can revoke them at any time.</p></details>
  <details><summary>How does the performance fee work?</summary><p>Each month we compare your account to its previous peak, adjusted for deposits and withdrawals. You only pay the plan's percentage on value above that peak. Losses must be recovered before any new fee is charged.</p></details>
  <details><summary>Is texting trades secure?</summary><p>Commands only work from the phone number you verified, and every order needs your personal PIN. You can pause all bots and scheduled trades with one text.</p></details>
  <details><summary>What is QuantConnect?</summary><p>QuantConnect is a professional algorithmic trading platform. Connect your QuantConnect account to create projects and run cloud backtests of Python LEAN algorithms right from QuantPocket.</p></details>
  <details><summary>Can I cancel any time?</summary><p>Yes. Plans are month to month. You can also export or delete all your data from Settings.</p></details>
</div></section>

<section><div class="wrap"><div class="band"><div><h2>Start with $100,000 in paper money.</h2><p style="margin:6px 0 0;color:#c3cde3">Free forever plan. No card required.</p></div><a class="btn light" data-app="#/register" href="app">Create your account</a></div></div></section>
'''
    return layout('QuantPocket: backtest, paper trade and automate stock strategies', 'Turn trading ideas into tested, automated strategies. Backtesting, AI strategy builder, QuantConnect, Alpaca trading, SMS and phone control, and a tax center.', body)

def doc(title, desc, content):
    return layout(f'{title} | QuantPocket', desc, f'<article class="doc"><h1>{title}</h1><p class="mu">Last updated {UPDATED}</p>{content}</article>')

TERMS = '''
<p>These Terms of Service ("Terms") govern your use of the QuantPocket website, apps, SMS and voice services (together, the "Service"). By creating an account you agree to these Terms.</p>
<h2>1. What QuantPocket is</h2>
<p>QuantPocket is software for researching, testing and automating trading strategies. We are not a broker-dealer, bank or custodian, and we do not hold customer securities. Live trading happens in your own brokerage account with Alpaca Securities LLC under your separate agreement with Alpaca.</p>
<h2>2. No investment advice</h2>
<p>Content, backtests, projections, templates and AI-generated rules are for information and education. They are not a recommendation to buy or sell any security. You decide which strategies to run and are responsible for every order placed from your account, including orders placed by bots, schedules, SMS or voice commands you set up.</p>
<h2>3. Eligibility and accounts</h2>
<p>You must be at least 18 years old and able to form a binding contract. Keep your password, PIN and two-factor device secure. You are responsible for activity under your account. Tell us immediately about any unauthorized use.</p>
<h2>4. Plans, fees and payments</h2>
<ul>
<li>Paid plans are billed monthly in advance through Stripe and renew automatically until cancelled.</li>
<li>Performance fees are calculated monthly at your plan's rate on account value above a high-water mark, adjusted for deposits and withdrawals. No performance fee is charged while an account is below its high-water mark.</li>
<li>Card deposits are accepted from debit cards only and are subject to verification and processing times before they are available in your brokerage account.</li>
<li>Fees are non-refundable except where required by law.</li>
</ul>
<h2>5. Acceptable use</h2>
<p>Do not misuse the Service: no unlawful activity, market manipulation, attempts to access other accounts, scraping, reverse engineering, or overloading our systems. We may suspend accounts that violate these Terms.</p>
<h2>6. Third-party services</h2>
<p>The Service connects to Alpaca, QuantConnect, Twilio, Stripe and other providers. Their terms govern your use of their services, and we are not responsible for their availability or actions.</p>
<h2>7. Data and availability</h2>
<p>Market data may be delayed, incomplete or inaccurate. Automated features run on a best-effort basis and may be delayed or fail to run, for example during outages or market closures. Do not rely on the Service as your only way to manage positions.</p>
<h2>8. Disclaimers</h2>
<p>The Service is provided "as is" without warranties of any kind. Past performance and hypothetical results do not guarantee future results.</p>
<h2>9. Limitation of liability</h2>
<p>To the maximum extent permitted by law, QuantPocket is not liable for trading losses, lost profits, or indirect or consequential damages. Our total liability for any claim is limited to the fees you paid us in the three months before the claim.</p>
<h2>10. Termination</h2>
<p>You may close your account at any time from Settings. We may suspend or end access for violations or legal reasons. Sections that by their nature should survive termination will survive.</p>
<h2>11. Changes</h2>
<p>We may update these Terms. Material changes will be announced by email or in the app before they take effect.</p>
<h2>12. Contact</h2>
<p>Questions? Use the <a href="contact.html">contact page</a>.</p>
'''
PRIVACY = '''
<p>This policy explains what personal information QuantPocket collects, why, and the choices you have.</p>
<h2>What we collect</h2>
<ul>
<li><b>Account data:</b> email address, a hashed password, optional phone number, a hashed PIN, two-factor settings, and tax-rate preferences.</li>
<li><b>Trading data:</b> strategies, paper and synced live orders, positions, scheduled trades, alerts and the ledger of fees and deposits.</li>
<li><b>Connected services:</b> Alpaca and QuantConnect API keys, encrypted with AES-256-GCM.</li>
<li><b>Security data:</b> IP address, browser type and a log of sign-ins and sensitive actions.</li>
<li><b>Payments:</b> handled by Stripe. We never see or store full card numbers.</li>
</ul>
<h2>How we use it</h2>
<p>To provide the Service, secure your account, process payments and fees, send messages you request (such as SMS replies, alerts and password resets), comply with law, and improve the product. We do not sell personal information.</p>
<h2>Who we share it with</h2>
<p>Service providers that run parts of the Service on our behalf: hosting and database (Render, Turso), brokerage (Alpaca), research (QuantConnect), messaging (Twilio, Resend), payments (Stripe) and AI (Anthropic, for the strategy builder only). We may disclose information when required by law.</p>
<h2>Cookies</h2>
<p>We use one essential, HttpOnly session cookie to keep you signed in. We do not use advertising or tracking cookies.</p>
<h2>Retention</h2>
<p>We keep your data while your account is open. When you delete your account we delete your data from our systems, except where we must keep records by law.</p>
<h2>Your choices</h2>
<p>From Settings you can download all your data (export) or permanently delete your account. You can also disconnect integrations and stop SMS at any time by replying STOP.</p>
<h2>Security</h2>
<p>Passwords and PINs are hashed with scrypt, API keys are encrypted, connections use HTTPS, and two-factor authentication is available. No system is perfectly secure, so please use a unique password and enable two-factor authentication.</p>
<h2>Children</h2>
<p>The Service is not for anyone under 18.</p>
<h2>Contact</h2>
<p>Privacy questions or requests: use the <a href="contact.html">contact page</a>.</p>
'''
RISK = '''
<div class="callout">Please read this before trading.</div>
<h2>Trading involves risk</h2>
<p>Investing in stocks and ETFs involves risk, including the possible loss of your entire investment. Automated and frequent trading can magnify losses and increase costs and taxes.</p>
<h2>Hypothetical results</h2>
<p>Backtests and projections are hypothetical. They are calculated with the benefit of hindsight, do not reflect actual trading, and may not account for slippage, liquidity, fees, taxes or market impact. Projected annual returns are statistical ranges built by resampling past returns. They are not forecasts or promises. Actual results will differ, possibly by a lot.</p>
<h2>Automation risk</h2>
<p>Bots, scheduled trades, SMS and voice commands can fail, run late, run more than once, or act on bad data. Speech recognition can mishear a command. Always monitor your account and keep the ability to act directly with your broker.</p>
<h2>AI-generated strategies</h2>
<p>The AI builder turns descriptions into rules automatically and can misunderstand you. Always review and backtest rules before using them.</p>
<h2>Brokerage</h2>
<p>Brokerage services are provided by Alpaca Securities LLC, member FINRA/SIPC. QuantPocket is not a broker-dealer and is not affiliated with Alpaca, QuantConnect, Twilio or Stripe. SIPC protection does not cover market losses.</p>
<h2>Margin and short selling</h2>
<p>QuantPocket strategies are long-only by default. If your brokerage account has margin enabled, losses can exceed your deposits.</p>
<h2>No advice</h2>
<p>Nothing in the Service is investment, legal or tax advice. Tax estimates are approximate. Your broker's Form 1099-B is the official record. Consult qualified professionals.</p>
'''
CONTACT = '''
<p>We usually reply within one business day.</p>
<form id="contactForm" style="max-width:560px">
  <label>Your name<input name="name" autocomplete="name"></label>
  <label>Email<input name="email" type="email" required autocomplete="email"></label>
  <label>Subject<select name="subject"><option>General question</option><option>Account or billing</option><option>Technical support</option><option>Security report</option><option>Privacy request</option></select></label>
  <label>Message<textarea name="body" required></textarea></label>
  <button class="btn" style="margin-top:14px">Send message</button>
  <div class="err" id="contactErr"></div>
</form>
<p class="mu" style="margin-top:30px">Urgent account security issue? Sign in and use Settings &gt; Active sessions to sign out other devices, change your password, and text <b>PAUSE &lt;PIN&gt;</b> to stop all automation.</p>
'''
NOTFOUND = '''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Page not found | QuantPocket</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;background:#0b1324;color:#e7ecf5;text-align:center;padding:16px}a{color:#8fb2ff}h1{font-size:64px;margin:0}</style></head>
<body><div><h1>404</h1><p>We could not find that page.</p><p><a href="/">Go to the home page</a></p></div></body></html>
'''

files = {
 'index.html': index(),
 'terms.html': doc('Terms of Service', 'The terms that govern your use of QuantPocket.', TERMS),
 'privacy.html': doc('Privacy Policy', 'What QuantPocket collects, why, and your choices.', PRIVACY),
 'risk.html': doc('Risk Disclosure', 'Important information about trading risk, backtests and automation.', RISK),
 'contact.html': doc('Contact & support', 'Get in touch with QuantPocket support.', CONTACT),
 '404.html': NOTFOUND,
}
for name, text in files.items():
    with open(os.path.join(OUT, name), 'w') as f: f.write(text)
print('wrote', ', '.join(files))
