/** Lazy production wiring. Disabled rollout neither contacts Stripe nor changes alpha access. */
import {billingEnabled, billingConfig, createBillingService, BillingError} from './billing.mjs';
export async function billingService() {
  const config = billingConfig();
  const [{db}, {createBillingStore}] = await Promise.all([import('./db.mjs'), import('./billing-store.mjs')]);
  return createBillingService({config, store: createBillingStore(db())});
}
export async function authorizePaidDraft(userId) {
  // A misspelled rollout flag must fail closed, not disable billing enforcement.
  const {DraftJobError} = await import('./draft-job-errors.mjs');
  try {
    if (!billingEnabled()) return;
    if (!(await (await billingService()).status(userId)).active) throw new BillingError('subscription_required');
  } catch (error) {
    throw new DraftJobError(error instanceof BillingError && error.code === 'subscription_required'
      ? 'subscription_required' : 'service_unavailable');
  }
}
