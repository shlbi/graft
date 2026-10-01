/**
 * @file Test-only durable-store and provider doubles for repair orchestration.
 * Real production orchestration and structural validation run; no provider calls,
 * credentials, database writes, model code execution or customer repositories.
 */
import { createDraftJobs } from '../draft-jobs.mjs';
import { DraftJobError } from '../draft-job-errors.mjs';
import { repairProgress, nextRepairContext } from '../draft-repair.mjs';
import { snapshot, analyze, reviewProposal } from '../../web/lib/core-base.mjs';
import { loadTestAI } from './repair-load-ai.mjs';

export const request = Object.freeze({ sourceRepo: 'sample/source', destinationRepo: 'sample/dest',
  feature: 'JSON task import and export preserving IDs and completion state', requestKey: 'json-transfer-001',
  allowAI: true, allowBackgroundProcessing: true });
export const source = snapshot({ name: 'sample/source', revision: 'a'.repeat(40), files: [
  { path: 'src/json.js', content: 'export const serialize = tasks => JSON.stringify(tasks);' }
] });
export const destination = snapshot({ name: 'sample/dest', revision: 'b'.repeat(40), files: [
  { path: 'src/app.js', content: 'export const tasks = [];' }
] });
export const context = analyze(source, destination, request.feature).context;

/** Build a complete synthetic model proposal; its code is never executed. */
export function validProposal() {
  return { summary: 'JSON import and export', risks: ['Run the destination checks.'], suggestedChecks: ['Verify task IDs round trip.'],
    changes: [{ path: 'src/json.js', action: 'add', content: 'export const serialize = tasks => JSON.stringify(tasks);',
      reason: 'Adapt task serialization.', sourcePaths: ['src/json.js'] }] };
}

/** Encode the exact provider response format without contacting OpenAI. */
export function responseFor(proposal) {
  return { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(proposal) }] }] };
}

/**
 * A fresh service object on each call proves no process-local repair state is
 * needed. The store double mirrors transactions; separate tests execute the real
 * store against a recording SQL driver. Neither double proves real PG concurrency.
 */
export async function repairFixture(responses, createJobs = createDraftJobs) {
  let time = Date.now(), sequence = 0, charges = 0, preparations = 0;
  const jobs = new Map(), reviews = new Map(), requests = [], deletions = [];
  const ai = await loadTestAI();
  const copy = value => structuredClone(value);
  /** Match owner-bound lookup behavior without exposing provider handles. */
  function row(user, id) { const r = jobs.get(id); if (!r || r.user_id !== user) throw new DraftJobError('job_not_found'); return r; }
  /** Check the worker token before mutating a simulated durable row. */
  function leased(c) { const r = row(c.user_id, c.id); if (!c.lease_token || r.lease_token !== c.lease_token) throw new DraftJobError('service_unavailable'); return r; }
  const terminal = r => ['failed','cancelled','completed'].includes(r.state);
  const store = {
    async create(user, key, hash, input, legacyHash) {
      const prior = [...jobs.values()].find(r => r.user_id === user && r.request_key === key);
      if (prior) { if (prior.request_hash !== hash && prior.request_hash !== legacyHash) throw new DraftJobError('request_key_conflict'); return copy(prior); }
      const r = { id: String(++sequence).padStart(32, '0'), user_id: user, request_key: key, request_hash: hash,
        state: 'queued', payload: JSON.stringify({ version: 1, request: input }), cancel_requested: false,
        charged: false, cleanup_pending: false, expires_at: new Date(time + 3600000), error_code: null };
      jobs.set(r.id, r); return copy(r);
    },
    async get(user, id) { return copy(row(user, id)); },
    async claim(user, id) { const r = row(user, id); if (terminal(r) || r.lease_token) return null; r.lease_token = 'lease-' + (++sequence); return copy(r); },
    context(r) { return JSON.parse(r.payload); },
    async prepared(c, value) { const r = leased(c); if (!r.cancel_requested) { r.state = 'prepared'; r.payload = JSON.stringify(value); } return copy(r); },
    async beginSubmission(c) {
      const r = leased(c); if (r.cancel_requested || r.state !== 'prepared') return null;
      if (r.cleanup_pending || r.response_id) throw new DraftJobError('service_unavailable');
      const v = store.context(r), p = repairProgress(v, r.charged);
      if (p.attempts >= p.maxAttempts) throw new DraftJobError('repair_budget_exhausted');
      if (charges >= fixture.quota) throw new DraftJobError('draft_limit');
      charges++; v.generation = { ...v.generation, attempts: p.attempts + 1 }; r.payload = JSON.stringify(v);
      r.state = 'submitting'; r.charged = true; r.provider_started_at = new Date(time); return copy(r);
    },
    async running(c, id) { const r = leased(c); r.state = 'running'; r.response_id = id; return copy(r); },
    async queueRepair(c, feedback) {
      const r = leased(c); if (r.cancel_requested || r.state !== 'running') return copy(r);
      const v = store.context(r); r.payload = JSON.stringify(nextRepairContext(v, feedback));
      r.state = 'prepared'; r.error_code = feedback.diagnostic.code; r.cleanup_pending = true; return copy(r);
    },
    async repairCleaned(c) { const r = leased(c); r.response_id = null; r.cleanup_pending = false; r.provider_started_at = null; return copy(r); },
    async complete(c, value, review) {
      const r = leased(c); if (r.cancel_requested || r.state !== 'running') return copy(r);
      r.review_id = 'review-' + (++sequence); reviews.set(r.review_id, copy(review));
      r.state = 'completed'; r.error_code = null; r.payload = null; r.cleanup_pending = true; return copy(r);
    },
    async finish(c, state, code) { const r = leased(c); if (!terminal(r)) Object.assign(r, { state, error_code: code, payload: null, cleanup_pending: Boolean(r.response_id) }); return copy(r); },
    async release(c) { const r = row(c.user_id, c.id); if (r.lease_token === c.lease_token) r.lease_token = null; },
    async requestCancel(user, id) { const r = row(user, id); if (!terminal(r)) r.cancel_requested = true; },
    async cleaned(user, id) { const r = row(user, id); r.cleanup_pending = false; r.response_id = null; }
  };
  const provider = {
    async start(payload, consent) {
      if (consent !== true) throw new Error('No consent');
      requests.push(copy(payload)); if (fixture.submitError) throw fixture.submitError;
      return { id: 'resp_attempt_' + requests.length, status: 'queued' };
    },
    async retrieve(id) {
      if (fixture.pollError) throw fixture.pollError;
      const attempt = Number(id.split('_').at(-1));
      return { id, ...copy(responses[Math.min(attempt - 1, responses.length - 1)]) };
    },
    async cleanup(id, cancel) { deletions.push({ id, cancel }); if (fixture.cleanupError) throw fixture.cleanupError; }
  };
  const fixture = { jobs, reviews, requests, deletions, store, provider, quota: 20, submitError: null, pollError: null, cleanupError: null,
    get charges() { return charges; }, get preparations() { return preparations; }, tick(ms) { time += ms; },
    service() { return createJobs({ store, provider, now: () => time,
      prepare: async input => { preparations++; return { source: { meta: { name: source.name }, snapshot: source },
        destination: { meta: { name: destination.name }, snapshot: destination }, context }; },
      buildRequest: value => ai.buildProposalRequest({ source, destination, context: value.context, repair: value.repair }),
      reviewResponse: fixture.reviewOverride ?? ((response, value) => ai.reviewFromAIResponse(response, { source, destination, context: value.context })) }); }
  };
  return fixture;
}

/** Start and advance through preparation/submission, using the same opaque job. */
export async function begin(f, options = {}) {
  const { jobId } = await f.service().start('alice', { ...request, ...options });
  await f.service().status('alice', jobId); await f.service().status('alice', jobId);
  return jobId;
}

/** Poll finitely; an accidental endless repair loop fails instead of hanging tests. */
export async function finish(f, id) {
  for (let i = 0; i < 20; i++) {
    const result = await f.service().status('alice', id);
    if (['failed','cancelled','completed'].includes(result.status)) return result;
  }
  throw new Error('Job did not terminate within the finite test budget');
}
