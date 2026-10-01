/**
 * @file PostgreSQL ownership, idempotency, leases and atomic review finalization for draft jobs.
 * Only opaque IDs/statuses leave this module. Request/snapshot content uses the existing data key.
 * No network call runs inside a transaction. A committed submission intent is never retried blindly.
 */
import { randomBytes } from 'node:crypto';
import { DraftJobError } from './draft-job-errors.mjs';
const TERMINAL = ['completed', 'failed', 'cancelled'];

/** Build an injectable store; production supplies pg Pool and the existing seal/open helpers. */
export function createDraftJobStore({ pool, seal, open, draftLimit = 20, reviewTtlMinutes = 60 }) {
  /** Execute a short, bounded transaction with rollback/release on every exit. */
  async function tx(work) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout = '5s'");
      await client.query("SET LOCAL lock_timeout = '3s'");
      const value = await work(client);
      await client.query('COMMIT');
      return value;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }
  /** Select a single owner-bound job. Identical not-found errors prevent cross-account enumeration. */
  async function row(client, userId, jobId, lock = false) {
    const { rows } = await client.query('SELECT * FROM public.repot_draft_job WHERE id=$1 AND user_id=$2' + (lock ? ' FOR UPDATE' : ''), [jobId, userId]);
    if (!rows[0]) throw new DraftJobError('job_not_found');
    return rows[0];
  }
  /** Serialize job creation per owner and deduplicate transport retries before any generation. */
  async function create(userId, requestKey, requestHash, request) {
    return tx(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['repot-draft:' + userId]);
      const prior = await client.query('SELECT * FROM public.repot_draft_job WHERE user_id=$1 AND request_key=$2', [userId, requestKey]);
      if (prior.rows[0]) {
        if (prior.rows[0].request_hash !== requestHash) throw new DraftJobError('request_key_conflict');
        return prior.rows[0];
      }
      const { rows } = await client.query(`SELECT count(*) FILTER (WHERE state NOT IN ('completed','failed','cancelled') AND expires_at>now())::int AS active,
        count(*) FILTER (WHERE created_at>now()-interval '1 day')::int AS recent
        FROM public.repot_draft_job WHERE user_id=$1`, [userId]);
      if (rows[0].active >= 3 || rows[0].recent >= 50) throw new DraftJobError('too_many_jobs');
      const result = await client.query(`INSERT INTO public.repot_draft_job(id,user_id,request_key,request_hash,payload)
        VALUES($1,$2,$3,$4,$5) RETURNING *`, [randomBytes(24).toString('base64url'), userId, requestKey, requestHash, seal({ version: 1, request })]);
      return result.rows[0];
    });
  }
  /** Read current status without trusting caller-provided provider IDs or review IDs. */
  async function get(userId, jobId) { return tx(client => row(client, userId, jobId)); }
  /** Claim at most one short step. Expired leases permit reads/polls, never a second submission. */
  async function claim(userId, jobId) {
    return tx(async client => {
      const current = await row(client, userId, jobId, true);
      if (TERMINAL.includes(current.state)) return null;
      const { rows } = await client.query(`UPDATE public.repot_draft_job SET lease_token=$3,
        lease_until=now()+interval '45 seconds',updated_at=now()
        WHERE id=$1 AND user_id=$2 AND (lease_until IS NULL OR lease_until<now())
        AND (next_poll_at<=now() OR cancel_requested OR expires_at<=now()) RETURNING *`, [jobId, userId, randomBytes(18).toString('base64url')]);
      return rows[0] ?? null;
    });
  }
  /** Reject a stale worker before committing any result. */
  async function ownedLease(client, claimed) {
    const current = await row(client, claimed.user_id, claimed.id, true);
    if (current.lease_token !== claimed.lease_token) throw new DraftJobError('service_unavailable');
    return current;
  }
  /** Decode only after server-side ownership/lease checks; versioning makes future changes explicit. */
  function context(claimed) {
    const value = open(claimed.payload);
    if (value?.version !== 1 || !value.request) throw new DraftJobError('service_unavailable');
    return value;
  }
  /** Persist pinned snapshots and selected context separately from provider submission. */
  async function prepared(claimed, value) {
    return tx(async client => {
      const current = await ownedLease(client, claimed);
      if (current.cancel_requested || current.state !== 'queued') return current;
      return (await client.query(`UPDATE public.repot_draft_job SET state='prepared',payload=$3,updated_at=now()
        WHERE id=$1 AND user_id=$2 RETURNING *`, [current.id, current.user_id, seal(value)])).rows[0];
    });
  }
  /** Charge once and commit the dispatch intent before contacting OpenAI; crash recovery never re-POSTs. */
  async function beginSubmission(claimed) {
    return tx(async client => {
      const current = await ownedLease(client, claimed);
      if (current.cancel_requested || current.state !== 'prepared') return null;
      await client.query('INSERT INTO public.repot_usage(user_id,usage_day) VALUES($1,CURRENT_DATE) ON CONFLICT DO NOTHING', [current.user_id]);
      const usage = await client.query('SELECT drafts FROM public.repot_usage WHERE user_id=$1 AND usage_day=CURRENT_DATE FOR UPDATE', [current.user_id]);
      if (usage.rows[0].drafts >= draftLimit) throw new DraftJobError('draft_limit');
      await client.query('UPDATE public.repot_usage SET drafts=drafts+1 WHERE user_id=$1 AND usage_day=CURRENT_DATE', [current.user_id]);
      return (await client.query(`UPDATE public.repot_draft_job SET state='submitting',charged=true,
        provider_started_at=now(),updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING *`, [current.id, current.user_id])).rows[0];
    });
  }
  /** Save the provider handle even when cancellation was requested concurrently, so it can be cleaned up. */
  async function running(claimed, responseId) {
    return tx(async client => {
      const current = await ownedLease(client, claimed);
      if (current.state === 'running' && current.response_id === responseId) return current;
      if (current.state !== 'submitting') throw new DraftJobError('service_unavailable');
      return (await client.query(`UPDATE public.repot_draft_job SET state='running',response_id=$3,
        next_poll_at=now()+interval '3 seconds',updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING *`, [current.id, current.user_id, responseId])).rows[0];
    });
  }
  /** Store a validated review and its job reference in one transaction; concurrency cannot create two reviews. */
  async function complete(claimed, value, review) {
    return tx(async client => {
      const current = await ownedLease(client, claimed);
      if (current.cancel_requested || current.state !== 'running') return current;
      const reviewId = randomBytes(24).toString('base64url');
      await client.query(`INSERT INTO public.repot_review(id,user_id,source_repo,destination_repo,destination_revision,payload,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,now()+($7::int * interval '1 minute'))`,
      [reviewId, current.user_id, value.source.meta.name, value.destination.meta.name, value.destination.snapshot.revision, seal(review), reviewTtlMinutes]);
      return (await client.query(`UPDATE public.repot_draft_job SET state='completed',review_id=$3,
        payload=NULL,cleanup_pending=true,updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING *`, [current.id, current.user_id, reviewId])).rows[0];
    });
  }
  /** Record a terminal outcome and drop source context; retain an opaque provider ID for best-effort cleanup. */
  async function finish(claimed, state, errorCode = null) {
    if (!['failed', 'cancelled'].includes(state)) throw new DraftJobError('service_unavailable');
    return tx(async client => {
      const current = await ownedLease(client, claimed);
      if (TERMINAL.includes(current.state)) return current;
      return (await client.query(`UPDATE public.repot_draft_job SET state=$3,error_code=$4,payload=NULL,
        cleanup_pending=(response_id IS NOT NULL),updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING *`, [current.id, current.user_id, state, errorCode])).rows[0];
    });
  }
  /** Request cancellation without stealing another worker's lease or undoing an already saved review. */
  async function requestCancel(userId, jobId) {
    return tx(async client => {
      const current = await row(client, userId, jobId, true);
      if (TERMINAL.includes(current.state)) return current;
      return (await client.query('UPDATE public.repot_draft_job SET cancel_requested=true,updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING *', [jobId, userId])).rows[0];
    });
  }
  /** Release only this worker's lease; delay provider polls to prevent accidental tight loops. */
  async function release(claimed) {
    return tx(client => client.query(`UPDATE public.repot_draft_job SET lease_token=NULL,lease_until=NULL,
      next_poll_at=CASE WHEN state='running' THEN now()+interval '3 seconds' ELSE now() END
      WHERE id=$1 AND user_id=$2 AND lease_token=$3`, [claimed.id, claimed.user_id, claimed.lease_token]));
  }
  /** Mark successful cleanup without exposing the provider response identifier. */
  async function cleaned(userId, jobId) {
    return tx(client => client.query('UPDATE public.repot_draft_job SET cleanup_pending=false,response_id=NULL WHERE id=$1 AND user_id=$2 AND state IN (\'completed\',\'failed\',\'cancelled\')', [jobId, userId]));
  }
  return { create, get, claim, context, prepared, beginSubmission, running, complete, finish, requestCancel, release, cleaned };
}
