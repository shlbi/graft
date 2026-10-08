/** Read-only Stripe setup checks. Never activates billing or performs a checkout. */
import {billingConfig, billingEnabled, createStripeClient, validPaymentLink, STRIPE_VERSION} from './billing.mjs';
import {BILLING_EVENTS, BILLING_RETURN_URL, BILLING_WEBHOOK_URL} from './billing-plan.mjs';

/** Fixed booleans/statuses only: no config values, provider bodies, or exception messages. */
export async function checkBillingSetup({env = process.env, clientFactory = createStripeClient} = {}) {
  const report = {
    scope: 'read-only-stripe-configuration', status: 'blocked',
    checks: {configuration: false, paymentLink: false, portal: false, webhook: false, webhookEnabled: false},
    verification: {database: 'not_run', checkout: 'not_run', signedWebhookDelivery: 'not_run',
      renewal: 'not_run', cancellation: 'not_run', liveActivation: 'not_performed'},
  };
  let config;
  try {
    billingEnabled(env); // Reject misspelled flags; false is valid for a setup inspection.
    config = billingConfig(env);
    if (!config.portalConfigId || !config.webhookEndpointId) return report;
    report.checks.configuration = true;
  } catch { return report; }
  try {
    const stripe = clientFactory(config);
    const [link, items, portal, webhook] = await Promise.all([
      stripe.link(), stripe.items(), stripe.portalConfiguration(), stripe.webhookEndpoint(),
    ]);
    report.checks.paymentLink = validPaymentLink(link, items, config);
    report.checks.portal = Boolean(portal?.id === config.portalConfigId && portal.active === true &&
      portal.livemode === config.live && portal.default_return_url === BILLING_RETURN_URL &&
      portal.features?.invoice_history?.enabled === true && portal.features?.payment_method_update?.enabled === true &&
      portal.features?.subscription_cancel?.enabled === true && portal.features.subscription_cancel.mode === 'at_period_end' &&
      portal.features.subscription_cancel.proration_behavior === 'none' && portal.features?.subscription_update?.enabled === false);
    report.checks.webhook = Boolean(webhook?.id === config.webhookEndpointId && webhook.livemode === config.live &&
      webhook.url === BILLING_WEBHOOK_URL && webhook.api_version === STRIPE_VERSION &&
      Array.isArray(webhook.enabled_events) && webhook.enabled_events.length === BILLING_EVENTS.length &&
      new Set(webhook.enabled_events).size === BILLING_EVENTS.length && BILLING_EVENTS.every(e => webhook.enabled_events.includes(e)));
    report.checks.webhookEnabled = report.checks.webhook && webhook.status === 'enabled';
    report.status = Object.values(report.checks).every(v => v === true) ? 'passed' : 'blocked';
  } catch { report.status = 'unavailable'; }
  return report;
}
