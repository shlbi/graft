/** Same-origin browser actions and a raw-body Stripe webhook. All dependencies are injected for tests. */
import {billingEnabled, billingConfig, stripeEvent, boundedBody, BillingError} from './billing.mjs';
const escape = value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
export const BILLING_CSS = `.billing-wrap{max-width:1100px;margin:0 auto;padding:28px 24px 70px}.billing-nav{display:flex;justify-content:space-between;gap:20px;align-items:center;margin-bottom:56px}.billing-nav a{color:inherit}.billing-title{font-size:clamp(38px,6vw,68px);line-height:1.05;margin:12px 0 20px}.billing-intro{max-width:640px;font-size:18px;line-height:1.6}.billing-grid{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin:32px 0}.billing-card{border:1px solid currentColor;border-radius:14px;padding:32px;display:flex;flex-direction:column;align-items:flex-start;gap:12px}.billing-card h2{margin:0;font-size:24px}.billing-price{font-size:44px;font-weight:700;margin:6px 0}.billing-price small{font-size:16px;font-weight:400}.billing-card p{line-height:1.6;margin:0}.billing-card .button{margin-top:12px}.billing-card button[disabled]{opacity:.55;cursor:not-allowed}.billing-notice{border-left:3px solid currentColor;padding:12px 18px;margin:24px 0;line-height:1.6}.billing-foot{font-size:14px;line-height:1.6}.billing-status{font-size:20px;font-weight:600}@media(max-width:650px){.billing-grid{grid-template-columns:1fr}.billing-card{padding:24px}.billing-nav{margin-bottom:36px}}`;
function headers(base) { const h = new Headers(base); h.set('cache-control','no-store'); h.set('referrer-policy','no-referrer'); h.delete('content-length'); h.delete('location'); return h; }
function redirect(location, base) { const h = headers(base); h.set('location',location); return new Response(null,{status:303,headers:h}); }
function page(body, base, status = 200) {
  const h = headers(base); h.set('content-type','text/html; charset=utf-8');
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>REPOT — Plans &amp; billing</title><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/brand.css"><link rel="stylesheet" href="/billing/style.css"></head><body><main class="billing-wrap"><nav class="billing-nav" aria-label="Billing navigation"><a class="wordmark" href="/">REPOT</a><a href="/billing">My billing</a></nav>${body}</main></body></html>`,{status,headers:h});
}
function unavailable(base, message = new BillingError().message, status = 503) {
  return page(`<h1 class="billing-title">Billing is not ready.</h1><p class="billing-notice" role="status">${escape(message)}</p><a class="button secondary" href="/pricing">Back to plans</a>`,base,status);
}
async function identity(request, getSession) {
  const upstream = await getSession({headers:request.headers,asResponse:true});
  if (!(upstream instanceof Response) || !upstream.ok) throw new BillingError();
  const data = await upstream.json(), session = data?.session, user = data?.user;
  const valid = typeof user?.id === 'string' && user.id && typeof session?.id === 'string' && session.id &&
    session.userId === user.id && new Date(session.expiresAt).getTime() > Date.now();
  return {userId:valid ? user.id : null, headers:headers(upstream.headers)};
}
export function createBillingHandlers({getSession, service, env = process.env}) {
  return {
    async pricing() {
      let ready = false, allowance = null;
      try { ready = billingEnabled(env); if (ready) allowance = billingConfig(env).allowance; } catch { ready = false; }
      const pay = ready ? '<a class="button primary" href="/billing/checkout" target="_blank" rel="noopener noreferrer">Pay $15/month ↗</a>'
        : '<button class="button primary" type="button" disabled>Pay $15/month — setup pending</button>';
      return page(`<p class="eyebrow">REPOT / CHOOSE YOUR PLAN</p><h1 class="billing-title">Move the feature.<br>Keep building.</h1><p class="billing-intro">Your GitHub account stays your REPOT identity. Choose how your AI usage is funded.</p><section class="billing-grid" aria-label="REPOT plans"><article class="billing-card"><h2>REPOT Pro</h2><p class="billing-price">$15 <small>USD / month</small></p><p>REPOT supplies the AI. Keep the existing review, test-preservation and draft-PR workflow.</p><p>${allowance ? `Up to ${allowance} AI attempts per UTC day. A transfer can use one generation plus up to two repairs; each counts toward the allowance.` : 'The included AI allowance will be published before checkout is enabled.'}</p>${pay}<p class="micro">Stripe-hosted checkout opens in a new tab. Taxes, when applicable, are shown by Stripe.</p></article><article class="billing-card"><h2>Use your ChatGPT plan</h2><p class="billing-price">$0 <small>to REPOT</small></p><p>Planned: bring an eligible ChatGPT plan instead of paying a separate REPOT subscription.</p><button class="button secondary" type="button" disabled>Continue with ChatGPT — coming soon</button><p class="micro">Not available yet. Requires an approved integration and user authorization. ChatGPT usage limits apply; this is not unlimited OpenAI usage.</p></article></section>${ready ? '' : '<p class="billing-notice" role="status">Payment setup is in progress. Checkout is disabled until account activation is configured and tested.</p>'}<p class="billing-foot">Paying or returning from Stripe does not by itself confirm access. REPOT verifies your linked subscription with Stripe before new AI submissions. Existing code review and publication safeguards still apply.</p>`);
    },
    async checkout(request) {
      let state;
      try {
        if (!billingEnabled(env)) return unavailable();
        billingConfig(env);
        state = await identity(request,getSession);
        if (!state.userId) return redirect('/sign-in?next=%2Fbilling%2Fcheckout',state.headers);
        return redirect(await (await service()).checkout(state.userId),state.headers);
      } catch (error) { return unavailable(state?.headers,error instanceof BillingError ? error.message : undefined); }
    },
    async account(request) {
      let state;
      try {
        state = await identity(request,getSession);
        if (!state.userId) return redirect('/sign-in?next=%2Fbilling',state.headers);
        if (!billingEnabled(env)) return unavailable(state.headers);
        const access = await (await service()).status(state.userId);
        // Never use ?success=, ?session_id=, browser storage or an email address as proof of payment.
        return page(`<p class="eyebrow">REPOT / YOUR BILLING</p><h1 class="billing-title">${access.active ? 'REPOT Pro is active.' : 'No active Pro access.'}</h1><p class="billing-notice">${access.active ? 'Your linked subscription is active and its latest invoice is paid.' : 'Payment may still be processing, or your subscription needs attention. Refresh this page before paying again.'}</p>${access.manageable ? '<form method="post" action="/billing/portal" target="_blank" rel="noopener noreferrer"><button class="button primary" type="submit">Manage subscription ↗</button></form>' : '<a class="button primary" href="/pricing">View plans</a>'}<p class="billing-foot">The Stripe portal opens separately for payment details and cancellation. Do not share checkout links containing your account reference.</p>`,state.headers);
      } catch { return unavailable(state?.headers); }
    },
    async portal(request) {
      let state;
      try {
        if (!billingEnabled(env)) return unavailable();
        // This browser POST creates a portal session. Pin the origin rather than trust Host headers.
        if (request.headers.get('origin') !== 'https://getrepot.com' ||
            !['same-origin',null].includes(request.headers.get('sec-fetch-site'))) return new Response(null,{status:403});
        state = await identity(request,getSession);
        if (!state.userId) return redirect('/sign-in?next=%2Fbilling',state.headers);
        return redirect(await (await service()).portal(state.userId),state.headers);
      } catch { return unavailable(state?.headers); }
    },
    async webhook(request) {
      try {
        if (!billingEnabled(env)) return new Response('Billing not enabled',{status:503});
        const config = billingConfig(env);
        const event = stripeEvent(await boundedBody(request), request.headers.get('stripe-signature'), config.secret);
        const result = await (await service()).webhook(event);
        return Response.json(result,{headers:{'cache-control':'no-store'}});
      } catch (error) {
        const invalid = error instanceof BillingError && error.code === 'invalid_webhook';
        return Response.json({error:invalid ? 'invalid_webhook' : 'billing_unavailable'},{status:invalid ? 400 : 503,headers:{'cache-control':'no-store'}});
      }
    },
  };
}
