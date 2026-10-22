# QuantPocket

Backtest, paper trade and automate US stock strategies. The repo holds two apps:

| Folder | What |
|---|---|
| `web/` | **Website**: multi-user platform (Node 22 + Express + SQLite) |
| `App.js` | Expo / React Native phone app (single user, local) |

## Website features

- **Accounts and security**: scrypt password hashing, TOTP two-factor (any authenticator app), lockout after 5 bad passwords, rate limits, HttpOnly SameSite cookies, CSRF header check, session list with remote sign-out, security log. Broker keys are encrypted with AES-256-GCM.
- **Backtesting**: a rule language (SMA, EMA, RSI, Bollinger, MACD, breakouts, ROC) with stop loss, take profit, trailing stop, position size and trading costs. Results include CAGR, Sharpe, Sortino, drawdown, profit factor, a trade list, **walk-forward** out-of-sample checks and a **parameter optimizer** (`SMA({10,20,50})`).
- **Projected annual return**: 2,000 bootstrapped years from the strategy's own daily returns, showing the 5th, 50th and 95th percentiles and the chance of a losing year.
- **AI strategy builder**: describe an idea in English and get runnable rules. Uses Claude when `ANTHROPIC_API_KEY` is set, otherwise a keyword parser.
- **Paper trading**: a built-in $100k simulated account, plus Alpaca paper.
- **Live trading through Alpaca**: connect your own keys (paper or live), see positions and orders, and place market orders.
- **QuantConnect**: connect your API token, create cloud projects from LEAN templates or your own Python code, run cloud backtests and read their statistics.
- **Auto-trading bots**: deploy a saved strategy to paper or Alpaca. It checks its rules every trading day at 3:45 pm New York time.
- **Scheduled trades**: one-off, daily, weekly (DCA) or monthly orders, and **price alerts** sent by SMS.
- **Text and phone hotline (Twilio)**: `BAL`, `POS`, `PRICE AAPL`, `BUY 5 AAPL <PIN>`, `DCA $50 SPY WEEKLY <PIN>`, `PAUSE <PIN>`. When calling, you enter your PIN, then use the keypad menu or say commands out loud ("buy five shares of Apple").
- **Portfolio chart**: the equity line is green above the starting value and red below it.
- **Tax information**: FIFO realized gains, short and long term, wash-sale flags, an estimated tax using your bracket, a loss carryforward, tax-loss harvesting ideas, and a Form 8949 CSV export.
- **Revenue**: monthly plans (Starter free, Pro $29, Elite $99) through Stripe Checkout, plus a **performance fee** (20%, 10% or 5% by plan) charged only on new profit above a high-water mark. The admin page shows MRR, fees due and collected, and deposits.
- **Debit card deposits**: Stripe Checkout. Credit cards are detected and refunded automatically.

## Run locally

```bash
cd web
npm install
npm start            # http://localhost:3000
npm test
```

Locally, the first account you register becomes the **admin**. In production, set `ADMIN_EMAIL` instead. Everything works without any keys: backtests use synthetic prices, SMS codes show on screen, and the payment buttons explain what is missing. Add keys from `web/.env.example` to turn on each integration.

## Deploy

GitHub Pages can only host static files. This site needs a server for logins, the database, the bots and the webhooks. Options:

- **Render**: New → Blueprint → select this repo (uses `render.yaml` with a persistent disk).
- **Any Docker host** (Fly.io, Railway, a VPS): `docker build -t quantpocket web && docker run -p 3000:3000 -v qp:/app/data --env-file web/.env quantpocket`.

Then point the webhooks at your domain:

| Service | URL |
|---|---|
| Twilio phone number → Messaging | `POST https://YOUR_DOMAIN/twilio/sms` |
| Twilio phone number → Voice | `POST https://YOUR_DOMAIN/twilio/voice` (status callback `/twilio/voice/status`) |
| Stripe → Webhooks | `https://YOUR_DOMAIN/webhooks/stripe` (`checkout.session.completed`, `customer.subscription.deleted`) |

## Before taking real customers' money — read this

The code is built for the business model you described. Running that business is regulated, though, and the code cannot get you the licenses:

1. **Performance fees.** Charging people a share of their trading profits, or running strategies on their accounts, generally makes you an investment adviser (SEC or state registration in the US). Performance fees are usually only allowed for "qualified clients".
2. **Holding deposits.** Taking card payments and moving that money into brokerage accounts is money transmission or custody. The right way is the **Alpaca Broker API**, where Alpaca opens and holds each customer's account and handles funding. The current flow puts card deposits in your Stripe balance and lists them on the admin page for manual transfer. Treat it as a placeholder until you have the Broker API and legal sign-off.
3. **Card networks** limit funding investment accounts with cards. Stripe needs to approve your use case.
4. **Projected returns** are shown as a statistical range with disclaimers. Do not advertise them as expected or guaranteed returns.

Talk to a securities lawyer before you go live. Until then, keep users on paper trading and on their own Alpaca accounts with their own keys.
