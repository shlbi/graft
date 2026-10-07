/** Deterministic billing tests with explicit Stripe/store doubles; no real payment is made. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {PAYMENT_LINK,billingEnabled,billingConfig,stripeEvent,validItems,subscriptionAccess,
  createBillingService,createStripeClient,withBillingGate,BillingError,boundedBody} from '../billing.mjs';
import {createBillingHandlers} from '../billing-http.mjs';
const env={REPOT_BILLING_ENABLED:'true',STRIPE_SECRET_KEY:'sk_test_'+'x'.repeat(12),
  STRIPE_WEBHOOK_SECRET:'whsec_'+'s'.repeat(12),STRIPE_TEST_PAYMENT_LINK:'https://buy.stripe.com/test_example',
  STRIPE_PRICE_ID:'price_expected',STRIPE_PAYMENT_LINK_ID:'plink_expected',REPOT_DAILY_DRAFT_LIMIT:'20'};
const config=billingConfig(env), now=Date.now(), ref='repot_'+'a'.repeat(32);
const price=()=>({id:config.priceId,livemode:false,currency:'usd',unit_amount:1500,type:'recurring',
  billing_scheme:'per_unit',active:true,recurring:{interval:'month',interval_count:1,usage_type:'licensed'}});
const items=()=>({data:[{quantity:1,price:price(),current_period_start:Math.floor(now/1000)-10,current_period_end:Math.floor(now/1000)+1000}],has_more:false});
const binding={subscription_id:'sub_expected',customer_id:'cus_expected'};
const sub=()=>({id:binding.subscription_id,customer:binding.customer_id,livemode:false,status:'active',items:items(),latest_invoice:{status:'paid'}});
function signed(event, timestamp=Math.floor(now/1000), secret=config.secret) {
  const raw=Buffer.from(JSON.stringify(event));
  const hash=createHmac('sha256',secret).update(timestamp+'.').update(raw).digest('hex');
  return {raw,signature:`t=${timestamp},v1=${hash}`};
}
const event=()=>({id:'evt_example',type:'checkout.session.completed',livemode:false,data:{object:{id:'cs_test_example'}}});
function setup({bindings=[]}={}) {
  const calls=[];
  const session={id:'cs_test_example',livemode:false,payment_link:config.linkId,mode:'subscription',status:'complete',
    created:Math.floor(now/1000),client_reference_id:ref,line_items:items(),subscription:binding.subscription_id,customer:binding.customer_id};
  const stripe={link:async()=>({id:config.linkId,url:config.link,active:true,livemode:false}),items:async()=>items(),
    session:async()=>session,subscription:async()=>sub(),portal:async c=>{calls.push(['portal',c]);return {url:'https://billing.stripe.com/p/session/test'};}};
  const store={bindings:async(uid,live)=>{calls.push(['bindings',uid,live]);return bindings;},
    reference:async(uid,live)=>{calls.push(['reference',uid,live]);return ref;},bind:async(s,live)=>calls.push(['bind',s,live])};
  return {calls,session,stripe,store,service:createBillingService({config,store,stripe,now:()=>now})};
}
test('production checkout URL is exactly the user-supplied link',()=>assert.equal(PAYMENT_LINK,'https://buy.stripe.com/5kQ28kdMW15M6mld42cfK00'));
test('billing is opt-in and misspelled activation flags fail closed',()=>{
  assert.equal(billingEnabled({}),false);assert.equal(billingEnabled({REPOT_BILLING_ENABLED:'false'}),false);
  assert.throws(()=>billingEnabled({REPOT_BILLING_ENABLED:'tru'}),BillingError);
});
test('live keys always select the exact approved public link; test keys require a test link',()=>{
  assert.equal(billingConfig({...env,STRIPE_SECRET_KEY:'sk_live_'+'x'.repeat(12)}).link,PAYMENT_LINK);
  assert.throws(()=>billingConfig({...env,STRIPE_TEST_PAYMENT_LINK:PAYMENT_LINK}),BillingError);
  for(const change of [{STRIPE_SECRET_KEY:''},{STRIPE_WEBHOOK_SECRET:''},{STRIPE_PRICE_ID:'../x'},
    {STRIPE_PAYMENT_LINK_ID:'unverified-slug'},{REPOT_DAILY_DRAFT_LIMIT:''},{REPOT_DAILY_DRAFT_LIMIT:'2.5'}])
    assert.throws(()=>billingConfig({...env,...change}),BillingError);
});
test('valid signed raw event is accepted, including rotated signatures',()=>{
  const s=signed(event());assert.deepEqual(stripeEvent(s.raw,s.signature,config.secret,now),event());
  assert.equal(stripeEvent(s.raw,s.signature+',v1='+'0'.repeat(64),config.secret,now).id,'evt_example');
});
for(const kind of ['tampered','old','future','wrong-secret','missing','duplicate-time','connected-account','malformed-json']) {
  test('webhook rejects '+kind,()=>{
    const s=signed(kind==='connected-account'?{...event(),account:'acct_other'}:event());
    if(kind==='tampered')s.raw=Buffer.from(s.raw.toString().replace('example','forged'));
    if(kind==='old')Object.assign(s,signed(event(),Math.floor(now/1000)-301));
    if(kind==='future')Object.assign(s,signed(event(),Math.floor(now/1000)+301));
    if(kind==='wrong-secret')Object.assign(s,signed(event(),Math.floor(now/1000),'whsec_wrong'));
    if(kind==='missing')s.signature='';
    if(kind==='duplicate-time')s.signature+=',t='+Math.floor(now/1000);
    if(kind==='malformed-json'){s.raw=Buffer.from('{');s.signature='t='+Math.floor(now/1000)+',v1='+createHmac('sha256',config.secret).update(Math.floor(now/1000)+'.').update(s.raw).digest('hex');}
    assert.throws(()=>stripeEvent(s.raw,s.signature,config.secret,now),BillingError);
  });
}
for(const [name,change] of [['one-time',p=>{p.type='one_time';p.recurring=null;}],['wrong amount',p=>p.unit_amount=100],
  ['annual',p=>p.recurring.interval='year'],['wrong price',p=>p.id='price_other'],['wrong currency',p=>p.currency='eur'],
  ['metered',p=>p.recurring.usage_type='metered'],['wrong mode',p=>p.livemode=true]]) {
  test('plan validation rejects '+name,()=>{const i=items();change(i.data[0].price);assert.equal(validItems(i,config),false);});
}
test('multiple items, adjustable quantity and wrong link cannot send a customer to checkout',async()=>{
  for(const mutate of [f=>{f.stripe.items=async()=>({...items(),has_more:true});},
    f=>{f.stripe.items=async()=>({has_more:false,data:[...items().data,...items().data]});},
    f=>{f.stripe.items=async()=>({has_more:false,data:[{quantity:2,price:price()}]});},
    f=>{f.stripe.items=async()=>({has_more:false,data:[{quantity:1,price:price(),adjustable_quantity:{enabled:true}}]});},
    f=>{f.stripe.link=async()=>({id:config.linkId,active:true,livemode:false,url:'https://evil.example'});}]) {
    const f=setup();mutate(f);await assert.rejects(f.service.checkout('owner'),BillingError);
    assert.equal(f.calls.filter(c=>c[0]==='reference').length,0);
  }
});
test('checkout appends only an opaque reference and retains the exact configured URL',async()=>{
  const f=setup(),url=new URL(await f.service.checkout('owner'));
  assert.equal(url.origin+url.pathname,config.link);assert.equal(url.searchParams.get('client_reference_id'),ref);
  assert.equal(url.searchParams.size,1);assert.ok(!url.href.includes('owner'));
});
test('existing active, delinquent and incomplete subscriptions block duplicate checkout',async()=>{
  for(const state of ['active','past_due','incomplete','trialing','unpaid','paused']) {
    const f=setup({bindings:[binding]});f.stripe.subscription=async()=>({...sub(),status:state});
    await assert.rejects(f.service.checkout('owner'),e=>e.code==='subscription_exists');
  }
});
test('access requires live current paid subscription, not an event or redirect flag',()=>{
  assert.equal(subscriptionAccess(sub(),binding,config,now),true);
  assert.equal(subscriptionAccess({...sub(),cancel_at_period_end:true},binding,config,now),true);
  for(const change of [{status:'past_due'},{status:'canceled'},{status:'unpaid'},{status:'trialing'},
    {latest_invoice:{status:'open'}},{latest_invoice:'in_not_expanded'},{pause_collection:{behavior:'void'}}])
    assert.equal(subscriptionAccess({...sub(),...change},binding,config,now),false);
  const s=sub();s.items.data[0].current_period_end=Math.floor(now/1000)-1;assert.equal(subscriptionAccess(s,binding,config,now),false);
  assert.throws(()=>subscriptionAccess({...sub(),customer:'cus_other'},binding,config,now),BillingError);
});
test('webhook refreshes the session and binds ownership only, even before delayed payment settles',async()=>{
  const f=setup();f.session.payment_status='unpaid';
  await f.service.webhook(event());await f.service.webhook(event());
  assert.equal(f.calls.filter(c=>c[0]==='bind').length,2);
  assert.equal(f.calls.some(c=>c[0]==='grant'),false);
});
test('wrong link, wrong mode and missing reference cannot link Pro',async()=>{
  const f=setup();f.session.payment_link='plink_other';await f.service.webhook(event());assert.equal(f.calls.length,0);
  f.session.payment_link=config.linkId;f.session.client_reference_id='owner';
  await assert.rejects(f.service.webhook(event()),e=>e.code==='checkout_unlinked');
  await assert.rejects(f.service.webhook({...event(),livemode:true}),e=>e.code==='invalid_webhook');
});
test('cancellation cannot be undone by an older completed-checkout notification',async()=>{
  const f=setup({bindings:[binding]});assert.equal((await f.service.status('owner')).active,true);
  f.stripe.subscription=async()=>({...sub(),status:'canceled'});await f.service.webhook(event());
  assert.equal((await f.service.status('owner')).active,false);
});
test('portal uses only the authenticated owner mapping and rejects a foreign redirect',async()=>{
  const f=setup({bindings:[binding]});await f.service.portal('owner');
  assert.deepEqual(f.calls.at(-1),['portal','cus_expected']);
  f.stripe.portal=async()=>({url:'https://billing.stripe.com.evil.example/p/session/x'});
  await assert.rejects(f.service.portal('owner'),BillingError);
});
test('new submissions and repairs authorize before quota/dispatch; other operations stay unchanged',async()=>{
  let allowed=false;const calls=[];const store={beginSubmission:async row=>{calls.push('submit');return row;},get:()=>42,cancel:()=>1};
  const gated=withBillingGate(store,async uid=>{calls.push(uid);if(!allowed)throw new BillingError('subscription_required');});
  assert.equal(gated.get,store.get);assert.equal(gated.cancel,store.cancel);
  await assert.rejects(gated.beginSubmission({user_id:'owner'}),BillingError);assert.deepEqual(calls,['owner']);
  allowed=true;await gated.beginSubmission({user_id:'owner',charged:0});await gated.beginSubmission({user_id:'owner',charged:1});
  assert.deepEqual(calls,['owner','owner','submit','owner','submit']);
});
test('Stripe transport has fixed origin, API version, timeout, no redirects and no POST retry',async()=>{
  const calls=[];const stripe=createStripeClient(config,async(url,opts)=>{calls.push({url,opts});return Response.json({url:'ok'});});
  await stripe.subscription('sub_example');await stripe.portal('cus_expected');
  assert.ok(calls.every(c=>c.url.startsWith('https://api.stripe.com/v1/')&&c.opts.redirect==='error'&&c.opts.signal));
  assert.equal(calls[0].opts.headers['Stripe-Version'],'2025-06-30.basil');
  assert.equal(calls[1].opts.method,'POST');assert.equal(calls.length,2);
  assert.throws(()=>stripe.subscription('../attacker'),BillingError);
});
test('API errors and oversized bodies are bounded and do not expose provider messages',async()=>{
  const stripe=createStripeClient(config,async()=>new Response('SECRET',{status:500}));
  await assert.rejects(stripe.link(),e=>e instanceof BillingError&&!e.message.includes('SECRET'));
  await assert.rejects(boundedBody(new Response('x'.repeat(262145))),BillingError);
});
function handlers(configEnv=env, sessionOverride) {
  const calls=[];
  const data=sessionOverride===undefined?{session:{id:'session',userId:'owner',expiresAt:new Date(Date.now()+60000).toISOString()},user:{id:'owner'}}:sessionOverride;
  const service={checkout:async uid=>{calls.push(['checkout',uid]);return config.link+'?client_reference_id='+ref;},
    status:async uid=>{calls.push(['status',uid]);return {active:false,manageable:false};},portal:async uid=>{calls.push(['portal',uid]);return 'https://billing.stripe.com/p/session/test';},webhook:async()=>{calls.push(['webhook']);return {received:true};}};
  const h=createBillingHandlers({env:configEnv,getSession:async()=>Response.json(data,{headers:{'set-cookie':'refresh=private; HttpOnly; Secure'}}),service:async()=>service});
  return {h,calls,service};
}
test('unconfigured pricing and checkout fail closed with no provider or store access',async()=>{
  const {h,calls}=handlers({});const html=await (await h.pricing()).text();
  assert.match(html,/Pay \$15\/month — setup pending/);assert.doesNotMatch(html,/href="https:\/\/buy/);
  assert.equal((await h.checkout(new Request('https://getrepot.com/billing/checkout'))).status,503);assert.equal(calls.length,0);
});
test('ready Pay link opens a separate tab, while unimplemented ChatGPT stays visibly disabled',async()=>{
  const {h}=handlers(),html=await(await h.pricing()).text();
  assert.match(html,/href="\/billing\/checkout" target="_blank" rel="noopener noreferrer"/);
  assert.match(html,/Continue with ChatGPT — coming soon/);assert.match(html,/ChatGPT usage limits apply/);
  assert.doesNotMatch(html,/sk_test_|whsec_|plink_expected/);
});
test('signed-in checkout uses the session owner, not caller-supplied identity; refresh cookies survive',async()=>{
  const {h,calls}=handlers();const r=await h.checkout(new Request('https://getrepot.com/billing/checkout?userId=attacker'));
  assert.equal(r.status,303);assert.equal(r.headers.get('location'),config.link+'?client_reference_id='+ref);
  assert.deepEqual(calls,[['checkout','owner']]);assert.match(r.headers.get('set-cookie'),/refresh=/);assert.equal(r.headers.get('cache-control'),'no-store');
});
test('missing or expired sessions return to GitHub sign-in, with a fixed safe continuation',async()=>{
  for(const data of [null,{session:{id:'s',userId:'other',expiresAt:new Date(now+60000).toISOString()},user:{id:'owner'}},
    {session:{id:'s',userId:'owner',expiresAt:new Date(now-60000).toISOString()},user:{id:'owner'}}]) {
    const {h,calls}=handlers(env,data),r=await h.checkout(new Request('https://getrepot.com/billing/checkout?next=https://evil.example'));
    assert.equal(r.headers.get('location'),'/sign-in?next=%2Fbilling%2Fcheckout');assert.equal(calls.length,0);
  }
});
test('success and session_id query parameters cannot activate an account',async()=>{
  const {h}=handlers();const r=await h.account(new Request('https://getrepot.com/billing?success=true&session_id=cs_stolen'));
  assert.match(await r.text(),/No active Pro access/);
});
test('portal browser POST rejects cross-origin actions before calling Stripe',async()=>{
  const {h,calls}=handlers();
  assert.equal((await h.portal(new Request('https://getrepot.com/billing/portal',{method:'POST',headers:{origin:'https://evil.example'}}))).status,403);
  assert.equal(calls.length,0);
  const r=await h.portal(new Request('https://getrepot.com/billing/portal',{method:'POST',headers:{origin:'https://getrepot.com','sec-fetch-site':'same-origin'}}));
  assert.equal(r.status,200);assert.equal(r.headers.get('location'),null);
  assert.match(await r.text(),/href="https:\/\/billing\.stripe\.com\/p\/session\/test"/);
  assert.deepEqual(calls,[['portal','owner']]);
});
test('raw webhook HTTP rejects forgery before service access and accepts a signed fixture',async()=>{
  const {h,calls}=handlers();const s=signed(event(),Math.floor(Date.now()/1000));
  const forged=await h.webhook(new Request('https://getrepot.com/api/billing/stripe',{method:'POST',body:s.raw}));
  assert.equal(forged.status,400);assert.equal(calls.length,0);
  const r=await h.webhook(new Request('https://getrepot.com/api/billing/stripe',{method:'POST',body:s.raw,headers:{'stripe-signature':s.signature}}));
  assert.equal(r.status,200);assert.deepEqual(calls,[['webhook']]);
});

// The portal must work without weakening the sign-in flow's exact CSP allowlist.
test('billing keeps the original global OAuth redirect policy',async()=>{
  const {default:config}=await import('../../next.config.mjs');
  const csp=(await config.headers())[0].headers.find(h=>h.key==='Content-Security-Policy').value;
  const action=csp.split(';').map(s=>s.trim()).find(s=>s.startsWith('form-action ')).split(/\s+/).slice(1);
  assert.deepEqual(action,["'self'",'https://github.com']);
  assert.doesNotMatch(csp,/unsafe-inline|https:\/\/billing\.stripe\.com|https:\/\/buy\.stripe\.com/);
});
test('portal no-referrer native forms require exact same-origin Fetch Metadata',async()=>{
  for(const [origin,site,expected] of [
    ['null','same-origin',200],['null','cross-site',403],['null',null,403],
    [null,'same-origin',403],['https://evil.example','same-origin',403],
    ['https://getrepot.com','cross-site',403],['https://getrepot.com',null,200],
  ]) {
    const {h,calls}=handlers();const headers=new Headers();
    if(origin!==null)headers.set('origin',origin);if(site!==null)headers.set('sec-fetch-site',site);
    const r=await h.portal(new Request('https://getrepot.com/billing/portal',{method:'POST',headers}));
    assert.equal(r.status,expected);assert.equal(calls.length,expected===200?1:0);
  }
});
test('portal handoff fails closed on invalid URLs and escapes validated query attributes',async()=>{
  for(const target of ['javascript:alert(1)','https://billing.stripe.com.evil.example/p/session/x','https://billing.stripe.com/other','https://user@billing.stripe.com/p/session/x']) {
    const {h,service}=handlers();service.portal=async()=>target;
    const r=await h.portal(new Request('https://getrepot.com/billing/portal',{method:'POST',headers:{origin:'https://getrepot.com'}}));
    assert.equal(r.status,503);assert.equal(r.headers.get('location'),null);
  }
  const {h,service}=handlers();service.portal=async()=>'https://billing.stripe.com/p/session/x?a=1&b=2';
  const r=await h.portal(new Request('https://getrepot.com/billing/portal',{method:'POST',headers:{origin:'https://getrepot.com'}}));
  assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('referrer-policy'),'no-referrer');
  assert.match(await r.text(),/a=1&amp;b=2/);
});
