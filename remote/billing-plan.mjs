/**
 * Non-secret live Stripe resource IDs verified through the owner's connected
 * Getrepot account on 2026-10-08. Never put API keys or signing secrets here.
 * These defaults do not enable billing, supply an allowance, or apply migrations.
 */
export const LIVE_STRIPE = Object.freeze({
  paymentLink: 'https://buy.stripe.com/5kQ28kdMW15M6mld42cfK00',
  linkId: 'plink_1UO45L6SP0lvEsfmU0B4F8ng',
  priceId: 'price_1UO43R6SP0lvEsfm4EilHFlL',
  portalConfigId: 'bpc_1UOLsP6SP0lvEsfmIH2Vvu9I',
  webhookEndpointId: 'we_1UOLu56SP0lvEsfmZzowySad',
});
export const BILLING_RETURN_URL = 'https://getrepot.com/billing';
export const BILLING_WEBHOOK_URL = 'https://getrepot.com/api/billing/stripe';
export const BILLING_EVENTS = Object.freeze([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
]);
