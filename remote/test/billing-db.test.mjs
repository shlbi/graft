/** Real persistence checks only against an explicitly named disposable local CI database. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createBillingStore} from '../billing-store.mjs';
const connectionString=process.env.TEST_BILLING_DATABASE_URL;
test('PostgreSQL migration, owner binding, concurrency and replay', {skip:!connectionString}, async()=>{
  const url=new URL(connectionString);
  assert.equal(url.hostname,'127.0.0.1');assert.equal(url.pathname,'/repot_billing_test');
  const {default:pg}=await import('pg');const pool=new pg.Pool({connectionString,max:5});
  try {
    await pool.query('DROP TABLE IF EXISTS repot_billing_subscriptions,repot_billing_checkout_refs');
    await pool.query('CREATE TABLE IF NOT EXISTS "user"(id text PRIMARY KEY)');
    await pool.query('INSERT INTO "user"(id) VALUES($1),($2) ON CONFLICT DO NOTHING',['owner-a','owner-b']);
    const sql=await readFile(new URL('../../docs/migrations/002-billing.sql',import.meta.url),'utf8');
    await pool.query(sql);await pool.query(sql);
    const store=createBillingStore(pool);
    const [a,a2,b]=await Promise.all([store.reference('owner-a',false),store.reference('owner-a',false),store.reference('owner-b',false)]);
    assert.equal(a,a2);assert.notEqual(a,b);
    const session={id:'cs_test_first',subscription:'sub_first',customer:'cus_first',client_reference_id:a,created:Math.floor(Date.now()/1000)};
    await store.bind(session,false);await store.bind(session,false);
    assert.equal((await store.bindings('owner-a',false)).length,1);
    assert.equal((await store.bindings('owner-b',false)).length,0);
    assert.equal((await store.bindings('owner-a',true)).length,0);
    await assert.rejects(store.bind({...session,client_reference_id:b},false),e=>e.code==='checkout_unlinked');
    assert.equal((await store.bindings('owner-a',false)).length,1);
    await assert.rejects(store.bind({...session,subscription:'sub_unknown',client_reference_id:'repot_'+'z'.repeat(32)},false),e=>e.code==='checkout_unlinked');
    // Two owners racing for the same subscription cannot both claim it.
    const outcomes=await Promise.allSettled([
      store.bind({...session,id:'cs_test_race_a',subscription:'sub_race',client_reference_id:a},false),
      store.bind({...session,id:'cs_test_race_b',subscription:'sub_race',client_reference_id:b},false),
    ]);
    assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(outcomes.filter(r=>r.status==='rejected').length,1);
    assert.equal(Number((await pool.query('SELECT count(*) FROM repot_billing_subscriptions WHERE subscription_id=$1',['sub_race'])).rows[0].count),1);
    // Expired-for-reuse references remain valid for attribution: never orphan a bookmarked-link payment.
    await pool.query("UPDATE repot_billing_checkout_refs SET created_at=now()-interval '3 days',expires_at=now()-interval '2 days' WHERE reference=$1",[a]);
    await store.bind({...session,id:'cs_test_delayed',subscription:'sub_delayed',created:Math.floor(Date.now()/1000)},false);
    assert.ok((await store.bindings('owner-a',false)).some(s=>s.subscription_id==='sub_delayed'));
    await pool.query('DELETE FROM "user" WHERE id=$1',['owner-a']);
    assert.equal((await store.bindings('owner-a',false)).length,0);
  } finally {await pool.end();}
});
