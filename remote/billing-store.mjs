/** Owner-bound references and Stripe IDs only. No card data, payment emails or provider credentials. */
import {randomBytes} from 'node:crypto';
import {BillingError} from './billing.mjs';
export function createBillingStore(pool) {
  async function transaction(work) {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const value = await work(client); await client.query('COMMIT'); return value; }
    catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }
  function user(value) { if (typeof value !== 'string' || !value || value.length > 200) throw new BillingError(); return value; }
  return {
    async bindings(userId, live) {
      return (await pool.query('SELECT subscription_id, customer_id FROM repot_billing_subscriptions WHERE user_id=$1 AND livemode=$2 ORDER BY created_at DESC LIMIT 11', [user(userId), live])).rows;
    },
    async reference(userId, live) {
      user(userId);
      return transaction(async client => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('repot-billing:' || $1))", [userId]);
        const prior = await client.query('SELECT reference FROM repot_billing_checkout_refs WHERE user_id=$1 AND livemode=$2 AND expires_at>now() ORDER BY created_at DESC LIMIT 1', [userId, live]);
        if (prior.rows.length) return prior.rows[0].reference;
        const reference = 'repot_' + randomBytes(24).toString('base64url');
        await client.query("INSERT INTO repot_billing_checkout_refs(reference,user_id,livemode,expires_at) VALUES($1,$2,$3,now()+interval '24 hours')", [reference, userId, live]);
        return reference;
      });
    },
    async bind(session, live) {
      return transaction(async client => {
        const ref = await client.query('SELECT user_id FROM repot_billing_checkout_refs WHERE reference=$1 AND livemode=$2 AND to_timestamp($3)>=created_at-interval \'1 second\' FOR UPDATE', [session.client_reference_id, live, session.created]);
        if (ref.rows.length !== 1) throw new BillingError('checkout_unlinked');
        const userId = ref.rows[0].user_id;
        // References are attribution, not access tokens. Retain old references so bookmarked links and delayed payments still reconcile.
        await client.query('INSERT INTO repot_billing_subscriptions(subscription_id,session_id,user_id,customer_id,livemode) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [session.subscription,session.id,userId,session.customer,live]);
        const saved = await client.query('SELECT session_id,user_id,customer_id,livemode FROM repot_billing_subscriptions WHERE subscription_id=$1', [session.subscription]);
        const row = saved.rows[0];
        if (!row || row.user_id !== userId || row.session_id !== session.id || row.customer_id !== session.customer || row.livemode !== live)
          throw new BillingError('checkout_unlinked');
      });
    },
  };
}
