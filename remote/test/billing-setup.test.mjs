/** Reduced observed configuration shapes with explicit API doubles; not live payment acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {billingConfig, billingEnabled, validPaymentLink, createStripeClient, STRIPE_VERSION, BillingError} from '../billing.mjs';
import {LIVE_STRIPE, BILLING_EVENTS, BILLING_RETURN_URL, BILLING_WEBHOOK_URL} from '../billing-plan.mjs';
import {checkBillingSetup} from '../billing-setup.mjs';
const liveEnv = () => ({STRIPE_SECRET_KEY: 'sk_live_' + 'x'.repeat(16),
  STRIPE_WEBHOOK_SECRET: 'whsec_' + 'y'.repeat(16), REPOT_DAILY_DRAFT_LIMIT: '5', REPOT_BILLING_ENABLED: 'false'});
const testEnv = () => ({...liveEnv(), STRIPE_SECRET_KEY: 'sk_test_' + 'x'.repeat(16),
  STRIPE_TEST_PAYMENT_LINK: 'https://buy.stripe.com/test_fixture',
  STRIPE_PAYMENT_LINK_ID: 'plink_fixture', STRIPE_PRICE_ID: 'price_fixture',
  STRIPE_PORTAL_CONFIGURATION_ID: 'bpc_fixture', STRIPE_WEBHOOK_ENDPOINT_ID: 'we_fixture'});
function fixture() {
  const env = liveEnv(), config = billingConfig(env), calls = [];
  const link = {id: LIVE_STRIPE.linkId, url: LIVE_STRIPE.paymentLink, active: true, livemode: true,
    managed_payments: {enabled: true}, automatic_tax: {enabled: true, liability: {type: 'stripe'}},
    subscription_data: {trial_period_days: null}};
  const items = {has_more: false, data: [{quantity: 1, adjustable_quantity: null,
    price: {id: LIVE_STRIPE.priceId, active: true, livemode: true, currency: 'usd', unit_amount: 1500,
      type: 'recurring', billing_scheme: 'per_unit', transform_quantity: null, tax_behavior: 'unspecified',
      recurring: {interval: 'month', interval_count: 1, usage_type: 'licensed'}}}]};
  const portal = {id: LIVE_STRIPE.portalConfigId, active: true, livemode: true, default_return_url: BILLING_RETURN_URL,
    features: {invoice_history: {enabled: true}, payment_method_update: {enabled: true},
      subscription_cancel: {enabled: true, mode: 'at_period_end', proration_behavior: 'none'},
      subscription_update: {enabled: false}}};
  const webhook = {id: LIVE_STRIPE.webhookEndpointId, livemode: true, url: BILLING_WEBHOOK_URL,
    api_version: STRIPE_VERSION, enabled_events: [...BILLING_EVENTS], status: 'enabled'};
  const values = {link, items, portalConfiguration: portal, webhookEndpoint: webhook};
  const clientFactory = () => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, async () => {
    calls.push(key); return value;
  }]));
  return {env, config, calls, values, link, items, portal, webhook, clientFactory};
}
test('verified non-secret live IDs are defaults without enabling billing or changing allowance', () => {
  const env = liveEnv(), config = billingConfig(env);
  for (const key of ['linkId', 'priceId', 'portalConfigId', 'webhookEndpointId']) assert.equal(config[key], LIVE_STRIPE[key]);
  assert.equal(config.link, LIVE_STRIPE.paymentLink); assert.equal(config.allowance, 5);
  assert.equal(billingEnabled(env), false); assert.equal(Object.isFrozen(LIVE_STRIPE), true);
  delete env.REPOT_DAILY_DRAFT_LIMIT; assert.throws(() => billingConfig(env), BillingError);
});
test('sandbox config needs its own link and price and does not inherit live portal/webhook IDs', () => {
  const env = testEnv(); delete env.STRIPE_PORTAL_CONFIGURATION_ID; delete env.STRIPE_WEBHOOK_ENDPOINT_ID;
  const config = billingConfig(env);
  assert.equal(config.portalConfigId, null); assert.equal(config.webhookEndpointId, null);
  assert.notEqual(config.linkId, LIVE_STRIPE.linkId); assert.notEqual(config.priceId, LIVE_STRIPE.priceId);
  delete env.STRIPE_PRICE_ID; assert.throws(() => billingConfig(env), BillingError);
});
test('explicit sandbox resources remain isolated', () => {
  const config = billingConfig(testEnv());
  assert.equal(config.portalConfigId, 'bpc_fixture'); assert.equal(config.webhookEndpointId, 'we_fixture');
});
for (const key of ['STRIPE_PAYMENT_LINK_ID', 'STRIPE_PRICE_ID', 'STRIPE_PORTAL_CONFIGURATION_ID', 'STRIPE_WEBHOOK_ENDPOINT_ID']) {
  test('invalid explicit ID is not silently replaced: ' + key, () => {
    for (const value of ['', '../other', 'https://example.invalid']) assert.throws(() => billingConfig({...liveEnv(), [key]: value}), BillingError);
  });
}
test('the observed Managed Payments shape satisfies the existing monthly-plan contract unchanged', () => {
  const f = fixture(), before = JSON.stringify([f.link, f.items]);
  assert.equal(validPaymentLink(f.link, f.items, f.config), true);
  assert.equal(JSON.stringify([f.link, f.items]), before);
});
test('null/missing provider objects cannot pass the shared checkout validator', () => {
  const f = fixture();
  assert.equal(validPaymentLink(null, f.items, f.config), false);
  assert.equal(validPaymentLink(f.link, null, f.config), false);
});
test('portal session requests include the selected configuration and owner customer', async () => {
  const config = billingConfig(liveEnv()); let request;
  const client = createStripeClient(config, async (url, options) => {
    request = {url, ...options}; return Response.json({url: 'https://billing.stripe.com/p/session/fixture'});
  });
  await client.portal('cus_fixture');
  const body = new URLSearchParams(request.body);
  assert.equal(request.method, 'POST'); assert.equal(body.get('configuration'), LIVE_STRIPE.portalConfigId);
  assert.equal(body.get('customer'), 'cus_fixture'); assert.equal(body.get('return_url'), BILLING_RETURN_URL);
});
test('configuration reads use fixed bounded Stripe GETs and never create a portal session', async () => {
  const config = billingConfig(liveEnv()), calls = [];
  const client = createStripeClient(config, async (url, options) => {
    calls.push({url, ...options}); return Response.json({});
  });
  await client.portalConfiguration(); await client.webhookEndpoint();
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.method, 'GET'); assert.equal(new URL(call.url).origin, 'https://api.stripe.com');
    assert.equal(call.redirect, 'error'); assert.equal(call.body, undefined); assert.ok(call.signal);
  }
});
test('missing secrets or sandbox setup cause no API call and reveal no secret values', async () => {
  let calls = 0; const clientFactory = () => { calls++; throw Error('unexpected'); };
  for (const env of [{}, {...liveEnv(), STRIPE_SECRET_KEY: ''}, {...testEnv(), STRIPE_WEBHOOK_ENDPOINT_ID: ''}]) {
    const result = await checkBillingSetup({env, clientFactory}); assert.equal(result.status, 'blocked');
  }
  assert.equal(calls, 0);
});
test('successful configuration inspection still does not claim payments, database or delivery were tested', async () => {
  const f = fixture(), report = await checkBillingSetup(f);
  assert.equal(report.status, 'passed'); assert.equal(f.calls.length, 4);
  assert.equal(report.verification.checkout, 'not_run'); assert.equal(report.verification.database, 'not_run');
  assert.equal(report.verification.signedWebhookDelivery, 'not_run');
  assert.equal(report.verification.liveActivation, 'not_performed');
  assert.equal(f.env.REPOT_BILLING_ENABLED, 'false');
  const text = JSON.stringify(report);
  assert.ok(!text.includes(f.config.key)); assert.ok(!text.includes(f.config.secret));
});
test('the staged disabled webhook reports blocked, not ready for live billing', async () => {
  const f = fixture(); f.webhook.status = 'disabled'; const r = await checkBillingSetup(f);
  assert.equal(r.checks.webhook, true); assert.equal(r.checks.webhookEnabled, false); assert.equal(r.status, 'blocked');
});
for (const [name, mutate] of [
  ['wrong plan amount', f => {f.items.data[0].price.unit_amount = 100;}],
  ['wrong webhook origin', f => {f.webhook.url = 'https://example.invalid/webhook';}],
  ['wrong webhook API version', f => {f.webhook.api_version = '2026-09-30.endive';}],
  ['duplicate webhook events', f => {f.webhook.enabled_events = [BILLING_EVENTS[0], BILLING_EVENTS[0]];}],
  ['wildcard webhook events', f => {f.webhook.enabled_events = ['*'];}],
  ['wrong portal mode', f => {f.portal.livemode = false;}],
  ['immediate cancellation', f => {f.portal.features.subscription_cancel.mode = 'immediately';}],
  ['unsupported plan changes', f => {f.portal.features.subscription_update.enabled = true;}],
  ['missing payment updates', f => {f.portal.features.payment_method_update.enabled = false;}],
]) {
  test('setup rejects ' + name, async () => {
    const f = fixture(); mutate(f); assert.equal((await checkBillingSetup(f)).status, 'blocked');
  });
}
test('provider/configuration exceptions cannot disclose secrets in an operator report', async () => {
  const f = fixture(); f.clientFactory = () => { throw Error(f.config.key + f.config.secret); };
  const r = await checkBillingSetup(f); assert.equal(r.status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(r), /sk_live_|whsec_/);
});
test('CLI without credentials fails with a bounded report, not an activation or traceback', () => {
  const result = spawnSync(process.execPath, ['scripts/check-billing-setup.mjs', '--check'], {
    cwd: new URL('../../', import.meta.url), env: {}, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 1); assert.equal(result.stderr, '');
  const r = JSON.parse(result.stdout); assert.equal(r.status, 'blocked');
  assert.equal(r.verification.liveActivation, 'not_performed');
});
