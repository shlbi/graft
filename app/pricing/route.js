/** REPOT billing route; no account activation is inferred from navigation. */
import {billingHandlers} from '../../remote/billing-routes.mjs';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;
export const GET = billingHandlers.pricing;
