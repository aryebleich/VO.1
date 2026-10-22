// Password hashing (scrypt), AES-256-GCM for broker keys at rest, TOTP (RFC 6238).
import crypto from 'node:crypto';

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(secret, salt, 32, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
export function verifySecret(secret, stored) {
  if (!stored) return false;
  const [, s, k] = stored.split('$');
  const key = crypto.scryptSync(secret, Buffer.from(s, 'base64'), 32, SCRYPT);
  const want = Buffer.from(k, 'base64');
  return want.length === key.length && crypto.timingSafeEqual(key, want);
}

// ENCRYPTION_KEY: 64 hex chars, or any random string of 32+ characters (hashed to 256 bits).
function masterKey() {
  const k = process.env.ENCRYPTION_KEY || '';
  if (/^[0-9a-f]{64}$/i.test(k)) return Buffer.from(k, 'hex');
  if (k.length >= 32) return crypto.createHash('sha256').update(k).digest();
  if (process.env.NODE_ENV === 'production') throw new Error('ENCRYPTION_KEY must be set (32+ random characters) in production');
  return crypto.createHash('sha256').update('dev-only-insecure-key').digest();
}
export function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map(b => b.toString('base64')).join('.');
}
export function decrypt(blob) {
  const [iv, tag, data] = blob.split('.').map(s => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', masterKey(), iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(data), d.final()]).toString('utf8'));
}

export const randomToken = (n = 32) => crypto.randomBytes(n).toString('base64url');
export const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
export function base32Decode(str) {
  let bits = 0, val = 0; const out = [];
  for (const ch of str.replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(ch); if (i < 0) continue;
    val = (val << 5) | i; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export const newTotpSecret = () => base32Encode(crypto.randomBytes(20));
export function totp(secret, t = Date.now(), step = 30) {
  const ctr = Buffer.alloc(8); ctr.writeBigUInt64BE(BigInt(Math.floor(t / 1000 / step)));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(ctr).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
export function verifyTotp(secret, code, t = Date.now()) {
  if (!secret || !/^\d{6}$/.test(String(code))) return false;
  return [-1, 0, 1].some(w => crypto.timingSafeEqual(Buffer.from(totp(secret, t + w * 30000)), Buffer.from(String(code))));
}
