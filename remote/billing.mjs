/** Stripe Payment Link billing. No API key, checkout email, or card data is exposed to clients. */
import {createHmac, timingSafeEqual} from 'node:crypto';
import {LIVE_STRIPE, BILLING_RETURN_URL} from './billing-plan.mjs';
export const PAYMENT_LINK = LIVE_STRIPE.paymentLink;
export const STRIPE_VERSION = '2025-06-30.basil';
const messages = {
  billing_unavailable: 'Billing setup is not complete or could not be verified. No new payment was started.',
  subscription_required: 'An active REPOT Pro subscription is required. Open https://getrepot.com/pricing. No AI request was submitted.',
  subscription_exists: 'A subscription is already linked. Manage it from your billing page instead of paying again.',
  checkout_unlinked: 'This checkout could not be linked automatically. Contact REPOT support; do not pay again.',
  invalid_webhook: 'Invalid payment notification.',
};
export class BillingError extends Error {
  constructor(code = 'billing_unavailable') { super(messages[code] ?? messages.billing_unavailable); this.code = code; }
}
export function billingEnabled(env = process.env) {
  if (![undefined, '', 'false', 'true'].includes(env.REPOT_BILLING_ENABLED)) throw new BillingError();
  return env.REPOT_BILLING_ENABLED === 'true';
}
const id = (value, prefix) => {
  if (typeof value !== 'string' || !new RegExp('^' + prefix + '_[A-Za-z0-9_]{1,180}$').test(value)) throw new BillingError();
  return value;
};
export function billingConfig(env = process.env) {
  const key = env.STRIPE_SECRET_KEY ?? '';
  const match = /^(?:sk|rk)_(live|test)_[A-Za-z0-9]{10,}$/.exec(key);
  if (!match || !/^whsec_[A-Za-z0-9]{10,}$/.test(env.STRIPE_WEBHOOK_SECRET ?? '')) throw new BillingError();
  const live = match[1] === 'live';
  const link = live ? PAYMENT_LINK : env.STRIPE_TEST_PAYMENT_LINK;
  if (!live && !/^https:\/\/buy\.stripe\.com\/test_[A-Za-z0-9]+$/.test(link ?? '')) throw new BillingError();
  // Requiring an explicit allowance avoids silently selling the alpha's default quota.
  const allowance = Number(env.REPOT_DAILY_DRAFT_LIMIT);
  if (!Number.isInteger(allowance) || allowance < 1 || allowance > 1000) throw new BillingError();
  // Never default sandbox requests to resources from the real merchant account.
  const defaults = live ? LIVE_STRIPE : {};
  const portalConfigId = env.STRIPE_PORTAL_CONFIGURATION_ID ?? defaults.portalConfigId;
  const webhookEndpointId = env.STRIPE_WEBHOOK_ENDPOINT_ID ?? defaults.webhookEndpointId;
  return {key, secret: env.STRIPE_WEBHOOK_SECRET, link, live, allowance,
    linkId: id(env.STRIPE_PAYMENT_LINK_ID ?? defaults.linkId, 'plink'),
    priceId: id(env.STRIPE_PRICE_ID ?? defaults.priceId, 'price'),
    portalConfigId: portalConfigId === undefined ? null : id(portalConfigId, 'bpc'),
    webhookEndpointId: webhookEndpointId === undefined ? null : id(webhookEndpointId, 'we')};
}
export async function boundedBody(response, max = 262144) {
  if (!response.body) throw new BillingError();
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) { const {done, value} = await reader.read(); if (done) break;
      size += value.byteLength; if (size > max) throw new BillingError(); chunks.push(value); }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
/** Signature verification uses the untouched bytes, timestamp tolerance and constant-time digest comparison. */
export function stripeEvent(raw, signature, secret, now = Date.now()) {
  if (!Buffer.isBuffer(raw) || raw.length > 262144 || typeof signature !== 'string' || signature.length > 4096 ||
      typeof secret !== 'string' || !secret.startsWith('whsec_')) throw new BillingError('invalid_webhook');
  const fields = signature.split(',').map(s => s.trim().split('='));
  const timestamps = fields.filter(([k]) => k === 't').map(([,v]) => v);
  if (timestamps.length !== 1 || !/^\d{1,12}$/.test(timestamps[0]) ||
      Math.abs(now / 1000 - Number(timestamps[0])) > 300) throw new BillingError('invalid_webhook');
  const expected = createHmac('sha256', secret).update(timestamps[0] + '.').update(raw).digest();
  const verified = fields.filter(([k,v]) => k === 'v1' && /^[a-f0-9]{64}$/.test(v ?? ''))
    .some(([,v]) => timingSafeEqual(expected, Buffer.from(v, 'hex')));
  if (!verified) throw new BillingError('invalid_webhook');
  let event; try { event = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(raw)); } catch { throw new BillingError('invalid_webhook'); }
  if (!event || !/^evt_[A-Za-z0-9]+$/.test(event.id ?? '') || typeof event.type !== 'string' ||
      typeof event.livemode !== 'boolean' || event.account || !event.data?.object) throw new BillingError('invalid_webhook');
  return event;
}
function validPrice(price, config) {
  return price?.id === config.priceId && price.livemode === config.live && price.currency === 'usd' &&
    price.unit_amount === 1500 && price.type === 'recurring' && price.billing_scheme === 'per_unit' &&
    price.recurring?.interval === 'month' && price.recurring.interval_count === 1 &&
    price.recurring.usage_type === 'licensed' && !price.transform_quantity;
}
export function validItems(items, config) {
  return items?.has_more === false && Array.isArray(items.data) && items.data.length === 1 &&
    items.data[0].quantity === 1 && validPrice(items.data[0].price, config);
}
/** Shared by checkout and the read-only operator setup check. */
export function validPaymentLink(link, items, config) {
  return Boolean(link?.id === config.linkId && link.url === config.link && link.active === true &&
    link.livemode === config.live && validItems(items, config) &&
    !items.data[0].adjustable_quantity?.enabled && items.data[0].price.active === true &&
    !link.subscription_data?.trial_period_days && !link.subscription_data?.trial_end && !link.optional_items?.length);
}
export function subscriptionAccess(sub, binding, config, now = Date.now()) {
  if (sub?.id !== binding.subscription_id || sub.customer !== binding.customer_id || sub.livemode !== config.live)
    throw new BillingError();
  const item = sub.items?.data?.[0];
  return sub.status === 'active' && !sub.pause_collection && validItems(sub.items, config) &&
    Number.isInteger(item.current_period_start) && item.current_period_start * 1000 <= now &&
    Number.isInteger(item.current_period_end) && item.current_period_end * 1000 > now &&
    sub.latest_invoice?.status === 'paid';
}
/** Fixed Stripe API origin. No redirects, implicit POST retries, unbounded responses or raw error messages. */
export function createStripeClient(config, fetchImpl = fetch) {
  async function call(endpoint, params, method = 'GET') {
    const query = new URLSearchParams(params);
    try {
      const response = await fetchImpl('https://api.stripe.com/v1/' + endpoint + (method === 'GET' ? '?' + query : ''), {
        method, signal: AbortSignal.timeout(8000), redirect: 'error',
        headers: {authorization: 'Bearer ' + config.key, 'Stripe-Version': STRIPE_VERSION,
          'content-type': 'application/x-www-form-urlencoded'}, ...(method === 'POST' ? {body: query.toString()} : {}),
      });
      if (!response.ok) { await response.body?.cancel(); throw new BillingError(); }
      return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(await boundedBody(response)));
    } catch { throw new BillingError(); }
  }
  return {
    link: () => call('payment_links/' + id(config.linkId, 'plink')),
    items: () => call('payment_links/' + id(config.linkId, 'plink') + '/line_items', [['limit','2']]),
    session: sessionId => call('checkout/sessions/' + id(sessionId, 'cs'), [['expand[]','line_items.data.price']]),
    subscription: subscriptionId => call('subscriptions/' + id(subscriptionId, 'sub'), [['expand[]','latest_invoice']]),
    portal: customerId => call('billing_portal/sessions', {customer: id(customerId, 'cus'), return_url: BILLING_RETURN_URL,
      ...(config.portalConfigId ? {configuration: id(config.portalConfigId, 'bpc')} : {})}, 'POST'),
    // Operator-only reads. These are not called by ordinary draft submissions.
    portalConfiguration: () => call('billing_portal/configurations/' + id(config.portalConfigId, 'bpc')),
    webhookEndpoint: () => call('webhook_endpoints/' + id(config.webhookEndpointId, 'we')),
  };
}
/** Webhooks bind ownership only. Access always reads current Stripe subscription/invoice state, avoiding stale-event grants. */
export function createBillingService({config, store, stripe = createStripeClient(config), now = Date.now}) {
  async function status(userId) {
    const bindings = await store.bindings(userId, config.live);
    if (bindings.length > 10) throw new BillingError(); // Explicit support case, never silently omit paid accounts.
    const subscriptions = await Promise.all(bindings.map(b => stripe.subscription(b.subscription_id)));
    const active = subscriptions.some((sub, i) => subscriptionAccess(sub, bindings[i], config, now()));
    return {active, canCheckout: subscriptions.every(s => ['canceled','incomplete_expired'].includes(s.status)),
      manageable: bindings.length > 0, allowance: config.allowance};
  }
  async function checkout(userId) {
    if (!(await status(userId)).canCheckout) throw new BillingError('subscription_exists');
    const [link, items] = await Promise.all([stripe.link(), stripe.items()]);
    if (!validPaymentLink(link, items, config)) throw new BillingError();
    const reference = await store.reference(userId, config.live);
    if (!/^repot_[A-Za-z0-9_-]{32}$/.test(reference)) throw new BillingError();
    const url = new URL(config.link); url.searchParams.set('client_reference_id', reference);
    return url.href;
  }
  async function webhook(event) {
    if (event.livemode !== config.live) throw new BillingError('invalid_webhook');
    if (!['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type)) return {received: true};
    const session = await stripe.session(event.data.object.id);
    if (session.id !== event.data.object.id || session.livemode !== config.live) throw new BillingError('invalid_webhook');
    if (session.payment_link !== config.linkId) return {received: true}; // Other products are not REPOT Pro.
    if (session.mode !== 'subscription' || session.status !== 'complete' || !validItems(session.line_items, config) ||
        !Number.isInteger(session.created) || !/^repot_[A-Za-z0-9_-]{32}$/.test(session.client_reference_id ?? ''))
      throw new BillingError('checkout_unlinked');
    id(session.subscription, 'sub'); id(session.customer, 'cus');
    // Delayed payments can bind ownership, but never grant access until the live invoice is paid.
    await store.bind(session, config.live);
    return {received: true};
  }
  async function portal(userId) {
    const bindings = await store.bindings(userId, config.live);
    const customers = [...new Set(bindings.map(b => b.customer_id))];
    if (customers.length !== 1) throw new BillingError(); // Duplicate-customer subscriptions need explicit support reconciliation.
    const result = await stripe.portal(customers[0]);
    const url = new URL(result.url);
    if (url.origin !== 'https://billing.stripe.com' || !url.pathname.startsWith('/p/session/') || url.username || url.password)
      throw new BillingError();
    return url.href;
  }
  return {status, checkout, webhook, portal};
}
/** Wrap only new submission authorization: polls, cleanup, cancellation and publication remain available. */
export function withBillingGate(store, authorize) {
  return {...store, async beginSubmission(claimed) {
    if (typeof claimed?.user_id !== 'string' || !claimed.user_id) throw new BillingError();
    await authorize(claimed.user_id);
    return store.beginSubmission(claimed);
  }};
}
