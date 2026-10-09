/**
 * Replay compact projections of actual Stripe test-mode responses through the
 * unmodified production entitlement code. No Stripe request or payment occurs
 * in this test file; injected time/bindings are explicitly harness inputs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {subscriptionAccess, createBillingService, withBillingGate, BillingError} from '../billing.mjs';

const record = JSON.parse(await readFile(new URL('../../docs/verification/stripe-testmode-snapshots.json', import.meta.url), 'utf8'));
const at = record.testClock.frozenTime * 1000;
const binding = sub => ({subscription_id: sub.id, customer_id: sub.customer});
const expectations = [
  ['paid_initial', true], ['declined_initial', false],
  ['cancellation_scheduled', true], ['paid_cancelled', false], ['declined_cleanup', false],
];
const find = name => record.cases.find(c => c.name === name).subscription;

test('observed record stays test-mode, scoped and separate from end-to-end acceptance', () => {
  assert.equal(record.recordType, 'observed-stripe-testmode-projections');
  assert.equal(record.livemode, false);
  assert.equal(record.config.live, false);
  assert.equal(record.testClock.advanced, false);
  assert.equal(record.sameApiVersionAcceptance, 'not_run');
  assert.equal(record.production.billingActivation, 'not_performed');
  assert.equal(record.production.liveMutationsThisSession, false);
  assert.deepEqual(record.cases.map(c => c.name), expectations.map(([name]) => name));
  assert.ok(record.notRun.includes('deployed-signed-webhook-delivery'));
  for (const c of record.cases) {
    assert.equal(c.subscription.livemode, false);
    assert.equal(c.subscription.test_clock, record.resources.clockId);
    assert.equal(c.subscription.items.data[0].price.id, record.config.priceId);
  }
});

for (const [name, expected] of expectations) {
  test('actual entitlement function against observed ' + name, () => {
    const c = record.cases.find(c => c.name === name);
    assert.equal(c.expectedAccessAtFrozenTime, expected);
    assert.equal(subscriptionAccess(c.subscription, binding(c.subscription), record.config, at), expected);
  });
}

test('a real paid invoice does not restore access after immediate cancellation', () => {
  const cancelled = find('paid_cancelled');
  assert.equal(cancelled.latest_invoice.status, 'paid');
  assert.equal(cancelled.latest_invoice.amount_paid, 1500);
  assert.equal(cancelled.status, 'canceled');
  assert.equal(subscriptionAccess(cancelled, binding(cancelled), record.config, at), false);
});

test('scheduled cancellation is not mistaken for a completed cancellation', () => {
  const sub = find('cancellation_scheduled');
  assert.equal(sub.status, 'active');
  assert.equal(sub.cancel_at_period_end, true);
  assert.equal(sub.cancel_at, sub.items.data[0].current_period_end);
  assert.equal(sub.ended_at, null);
  assert.equal(subscriptionAccess(sub, binding(sub), record.config, at), true);
});

for (const [name, override] of [
  ['different customer', {customer_id:'cus_other'}],
  ['different subscription', {subscription_id:'sub_other'}],
]) {
  test('observed paid response cannot cross ' + name + ' binding', () => {
    const sub = find('paid_initial');
    assert.throws(() => subscriptionAccess(sub, {...binding(sub), ...override}, record.config, at), BillingError);
  });
}

test('test-mode response never grants live entitlement', () => {
  const sub = find('paid_initial');
  assert.throws(() => subscriptionAccess(sub, binding(sub), {...record.config, live:true}, at), BillingError);
});

test('wrong configured price cannot grant entitlement from a paid response', () => {
  const sub = find('paid_initial');
  assert.equal(subscriptionAccess(sub, binding(sub), {...record.config, priceId:'price_other'}, at), false);
});

test('injected time boundaries fail closed; this is not a real test-clock advance', () => {
  const sub = find('cancellation_scheduled');
  const item = sub.items.data[0], check = time => subscriptionAccess(sub, binding(sub), record.config, time);
  assert.equal(check(item.current_period_start * 1000 - 1), false);
  assert.equal(check(item.current_period_start * 1000), true);
  assert.equal(check(item.current_period_end * 1000 - 1), true);
  assert.equal(check(item.current_period_end * 1000), false);
});

for (const [name, expected] of expectations) {
  test('submission gate with observed ' + name + ' and explicit store/provider doubles', async () => {
    const sub = find(name), calls = [];
    const service = createBillingService({
      config:{...record.config, allowance:1}, now:() => at,
      store:{bindings:async (user, mode) => {calls.push(['owner', user, mode]); return [binding(sub)];}},
      stripe:{subscription:async id => {assert.equal(id, sub.id); return sub;}},
    });
    let dispatches = 0;
    const wrapped = withBillingGate({beginSubmission:async () => {dispatches++; return 'dispatched';}}, async user => {
      if (!(await service.status(user)).active) throw new BillingError('subscription_required');
    });
    const action = wrapped.beginSubmission({user_id:'synthetic-repot-owner'});
    if (expected) assert.equal(await action, 'dispatched');
    else await assert.rejects(action, e => e.code === 'subscription_required');
    assert.equal(dispatches, expected ? 1 : 0);
    assert.deepEqual(calls, [['owner','synthetic-repot-owner',false]]);
  });
}
