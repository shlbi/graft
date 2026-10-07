/** No database/secret/provider work during route import or the static build. */
import {createBillingHandlers} from './billing-http.mjs';
export const billingHandlers = createBillingHandlers({
  getSession: async options => (await import('./auth.mjs')).getAuth().api.getSession(options),
  service: async () => (await import('./billing-service.mjs')).billingService(),
});
