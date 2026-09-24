import { randomBytes, createHash, createCipheriv, createDecipheriv, timingSafeEqual, createHmac } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export function ensure(ok, status, code, message) { if (!ok) throw new HttpError(status, code, message); }
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const opaque = () => randomBytes(32).toString('base64url');
export function equal(a, b) {
  return typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
export function cryptoBox(key) {
  ensure(typeof key === 'string' && /^[a-f0-9]{64}$/i.test(key), 500, 'configuration', 'GRAFT_DATA_KEY must contain 64 hexadecimal characters.');
  const bytes = Buffer.from(key, 'hex');
  return {
    seal(value, aad) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', bytes, iv);
      cipher.setAAD(Buffer.from(aad));
      return Buffer.concat([iv, cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]).toString('base64');
    },
    open(text, aad) {
      const b = Buffer.from(text, 'base64');
      if (b.length < 29) throw new Error('Invalid encrypted record');
      const decipher = createDecipheriv('aes-256-gcm', bytes, b.subarray(0, 12));
      decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(b.subarray(-16));
      return JSON.parse(Buffer.concat([decipher.update(b.subarray(12, -16)), decipher.final()]).toString('utf8'));
    }
  };
}
export function readConfig(env = process.env) {
  const development = env.GRAFT_ENV === 'development';
  const url = new URL(env.GRAFT_PUBLIC_URL || (development ? 'http://127.0.0.1:4319' : 'https://invalid.invalid'));
  ensure(url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password, 500, 'configuration', 'Use an origin-only GRAFT_PUBLIC_URL.');
  ensure(development ? url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname) : url.protocol === 'https:' && url.hostname !== 'invalid.invalid', 500, 'configuration', 'Connected service requires an explicit HTTPS origin; development is loopback HTTP only.');
  const ids = (env.GRAFT_ALLOWED_USER_IDS || '').split(',').filter(Boolean);
  ensure(ids.length > 0 && ids.every(x => /^[1-9]\d{0,14}$/.test(x)), 500, 'configuration', 'Set GRAFT_ALLOWED_USER_IDS to invited numeric GitHub user IDs.');
  ensure(/^[A-Za-z0-9_.-]{1,100}$/.test(env.GRAFT_GITHUB_CLIENT_ID || '') && (env.GRAFT_GITHUB_CLIENT_SECRET || '').length >= 20, 500, 'configuration', 'GitHub App client ID and client secret are required.');
  ensure(/^[1-9]\d{0,14}$/.test(env.GRAFT_GITHUB_APP_ID || ''), 500, 'configuration', 'GitHub App numeric ID is required.');
  ensure((env.GRAFT_WEBHOOK_SECRET || '').length >= 32, 500, 'configuration', 'Use a webhook secret of at least 32 characters.');
  cryptoBox(env.GRAFT_DATA_KEY);
  const number = (key, fallback, max) => { const n = Number(env[key] ?? fallback); ensure(Number.isInteger(n) && n >= 1 && n <= max, 500, 'configuration', `Invalid ${key}.`); return n; };
  const providerKey = env.OPENAI_API_KEY || '', model = env.GRAFT_AI_MODEL || '';
  ensure(Boolean(providerKey) === Boolean(model), 500, 'configuration', 'Configure both OPENAI_API_KEY and GRAFT_AI_MODEL, or neither.');
  return Object.freeze({ origin: url.origin, host: url.host, development, allowedUsers: new Set(ids),
    clientId: env.GRAFT_GITHUB_CLIENT_ID, clientSecret: env.GRAFT_GITHUB_CLIENT_SECRET, appId: Number(env.GRAFT_GITHUB_APP_ID),
    webhookSecret: env.GRAFT_WEBHOOK_SECRET, dataKey: env.GRAFT_DATA_KEY, database: env.GRAFT_DATABASE || './.graft-data/connected.sqlite',
    writesEnabled: env.GRAFT_ENABLE_PR_WRITES === 'true', providerKey, model,
    userDailyLimit: number('GRAFT_USER_DAILY_DRAFTS', 3, 100), globalDailyLimit: number('GRAFT_GLOBAL_DAILY_DRAFTS', 20, 1000),
    maxActive: 2, retentionMs: 24 * 60 * 60 * 1000, sessionMs: 8 * 60 * 60 * 1000 });
}
export function cookieName(config, kind) { return `${config.development ? '' : '__Host-'}graft-${kind}`; }
export function cookie(config, kind, value, seconds) {
  return `${cookieName(config, kind)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${config.development ? '' : '; Secure'}`;
}
export function readCookie(req, name) {
  const hits = (req.headers.cookie || '').split(';').map(s => s.trim()).filter(s => s.startsWith(name + '='));
  if (hits.length !== 1) return null;
  const value = hits[0].slice(name.length + 1); return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
export function checkOrigin(req, config, mutation = false) {
  ensure(req.headers.host === config.host, 403, 'host', 'Unexpected Host header.');
  if (mutation) {
    ensure(req.headers.origin === config.origin, 403, 'origin', 'A same-origin request is required.');
    ensure(!['cross-site', 'same-site'].includes(req.headers['sec-fetch-site']), 403, 'origin', 'Cross-site request denied.');
  }
}
export async function bodyBytes(req, limit = 16_384) {
  ensure(!req.headers['content-encoding'] || req.headers['content-encoding'] === 'identity', 415, 'encoding', 'Compressed request bodies are not accepted.');
  const chunks = []; let size = 0;
  for await (const part of req) { size += part.length; ensure(size <= limit, 413, 'body_limit', 'Request is too large.'); chunks.push(part); }
  return Buffer.concat(chunks);
}
export async function jsonBody(req) {
  ensure(req.headers['content-type']?.split(';')[0].trim() === 'application/json', 415, 'content_type', 'Use application/json.');
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await bodyBytes(req)));
    ensure(value && typeof value === 'object' && !Array.isArray(value), 400, 'body', 'Expected a JSON object.'); return value;
  } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, 'body', 'Invalid JSON.'); }
}
export function exactKeys(obj, keys) { ensure(Object.keys(obj).sort().join('|') === [...keys].sort().join('|'), 400, 'fields', 'Unexpected or missing request fields.'); }
export function verifyWebhook(bytes, signature, secret) {
  return equal(signature, 'sha256=' + createHmac('sha256', secret).update(bytes).digest('hex'));
}
export function limiter({ windowMs = 60_000, max = 60, capacity = 5000, now = Date.now } = {}) {
  const buckets = new Map();
  return key => {
    const t = now(); for (const [k, v] of buckets) if (v.until <= t) buckets.delete(k);
    let b = buckets.get(key); if (!b) { ensure(buckets.size < capacity, 429, 'rate_limit', 'Too many clients. Try again later.'); buckets.set(key, b = { count: 0, until: t + windowMs }); }
    ensure(++b.count <= max, 429, 'rate_limit', 'Too many requests. Try again later.');
  };
}
