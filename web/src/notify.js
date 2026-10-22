// Twilio (SMS + voice hotline) and Stripe (plans + debit card deposits) over plain HTTPS.
import crypto from 'node:crypto';

const env = k => process.env[k];
export const twilioEnabled = () => !!(env('TWILIO_ACCOUNT_SID') && env('TWILIO_AUTH_TOKEN') && env('TWILIO_FROM'));
export const stripeEnabled = () => !!env('STRIPE_SECRET_KEY');

export async function sendSms(to, body) {
  if (!twilioEnabled()) { console.log(`[sms disabled] to ${to}: ${body}`); return { simulated: true }; }
  const sid = env('TWILIO_ACCOUNT_SID');
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${env('TWILIO_AUTH_TOKEN')}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: to, From: env('TWILIO_FROM'), Body: body.slice(0, 1500) }),
  });
  if (!r.ok) throw new Error('Twilio ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r.json();
}

// https://www.twilio.com/docs/usage/webhooks/webhooks-security
export function validTwilioSignature(url, params, signature) {
  if (!env('TWILIO_AUTH_TOKEN')) return process.env.NODE_ENV !== 'production';
  const data = url + Object.keys(params).sort().map(k => k + params[k]).join('');
  const want = crypto.createHmac('sha1', env('TWILIO_AUTH_TOKEN')).update(data).digest('base64');
  return !!signature && signature.length === want.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(want));
}

export const xml = s => String(s).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

async function stripe(path, params) {
  const r = await fetch('https://api.stripe.com/v1' + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env('STRIPE_SECRET_KEY'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const d = await r.json();
  if (!r.ok) throw new Error('Stripe: ' + (d.error?.message || r.status));
  return d;
}

export function checkoutSubscription({ plan, email, userId, baseUrl }) {
  const price = env(`STRIPE_PRICE_${plan.toUpperCase()}`);
  if (!price) throw new Error(`Set STRIPE_PRICE_${plan.toUpperCase()} to the Stripe price id for this plan`);
  return stripe('/checkout/sessions', {
    mode: 'subscription', customer_email: email, client_reference_id: String(userId), 'metadata[plan]': plan, 'metadata[kind]': 'subscription',
    'line_items[0][price]': price, 'line_items[0][quantity]': '1',
    success_url: `${baseUrl}/#/billing?ok=1`, cancel_url: `${baseUrl}/#/billing`,
  });
}

// Card deposit. payment_method_types=card accepts debit and credit; we restrict to debit
// by checking card funding in the webhook (Stripe reports card.funding = 'debit').
export function checkoutDeposit({ amount, email, userId, ledgerId, baseUrl }) {
  return stripe('/checkout/sessions', {
    mode: 'payment', customer_email: email, client_reference_id: String(userId), 'payment_method_types[0]': 'card',
    'metadata[kind]': 'deposit', 'metadata[ledger_id]': String(ledgerId),
    'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][product_data][name]': 'Account deposit',
    'line_items[0][price_data][unit_amount]': String(Math.round(amount * 100)), 'line_items[0][quantity]': '1',
    'payment_intent_data[metadata][ledger_id]': String(ledgerId),
    success_url: `${baseUrl}/#/funding?ok=1`, cancel_url: `${baseUrl}/#/funding`,
  });
}

export async function cardFunding(paymentIntentId) {
  const r = await fetch(`https://api.stripe.com/v1/payment_intents/${paymentIntentId}?expand[]=latest_charge`, { headers: { Authorization: 'Bearer ' + env('STRIPE_SECRET_KEY') } });
  const d = await r.json();
  return d.latest_charge?.payment_method_details?.card?.funding;
}

export const refund = paymentIntent => stripe('/refunds', { payment_intent: paymentIntent });

// https://docs.stripe.com/webhooks#verify-manually
export function verifyStripe(raw, header) {
  const secret = env('STRIPE_WEBHOOK_SECRET');
  if (!secret || !header) return false;
  const parts = Object.fromEntries(header.split(',').map(p => p.split('=')));
  if (Math.abs(Date.now() / 1000 - +parts.t) > 300) return false;
  const want = crypto.createHmac('sha256', secret).update(`${parts.t}.${raw}`).digest('hex');
  return !!parts.v1 && parts.v1.length === want.length && crypto.timingSafeEqual(Buffer.from(parts.v1), Buffer.from(want));
}

// Transactional email through Resend (free tier: 3,000/month). Without a key the message is
// logged, which is enough for local development.
export const emailEnabled = () => !!env('RESEND_API_KEY');
export async function sendEmail(to, subject, text) {
  if (!emailEnabled()) { console.log(`[email disabled] to ${to}: ${subject}\n${text}`); return { simulated: true }; }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env('RESEND_API_KEY'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env('EMAIL_FROM') || 'QuantPocket <onboarding@resend.dev>', to: [to], subject, text }),
  });
  if (!r.ok) throw new Error('Email ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r.json();
}
