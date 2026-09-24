import { featureText } from '../lib/core-base.mjs';
import { ensure, HttpError, exactKeys, sha256 } from './security.mjs';
import { reviewDigest, deliver } from './delivery.mjs';

async function buildDraft(source, destination, feature, config, signal) {
  // Reuse the shipped parser, test postprocessor and consent-gated provider; no second transfer engine.
  const { analyze } = await import('../lib/core.mjs');
  const { proposeWithAI } = await import('../lib/ai.mjs');
  const analysis = analyze(source, destination, feature);
  const review = await proposeWithAI({ source, destination, context: analysis.context, consent: true,
    apiKey: config.providerKey, model: config.model, signal });
  const { context, ...publicAnalysis } = analysis;
  return { analysis: publicAnalysis, review };
}
export class Service {
  constructor(store, github, config, { draft = buildDraft } = {}) {
    this.store = store; this.github = github; this.config = config; this.draft = draft;
    this.active = new Map(); this.pending = new Set(); store.purge(); store.recover();
  }
  start(sessionKey, session, input) {
    exactKeys(input, ['sourceId', 'destinationId', 'feature', 'consentAI']);
    ensure(input.consentAI === true, 403, 'consent', 'Confirm sending selected code to the configured AI provider.');
    ensure(this.config.providerKey && this.config.model, 503, 'ai_disabled', 'AI drafting is not configured.');
    ensure(Number.isSafeInteger(input.sourceId) && input.sourceId > 0 && Number.isSafeInteger(input.destinationId) && input.destinationId > 0 && input.sourceId !== input.destinationId, 400, 'repositories', 'Choose two different repositories.');
    let feature; try { feature = featureText(input.feature); } catch { throw new HttpError(400, 'feature', 'Describe a feature in 3–1500 characters without credentials.'); }
    const job = this.store.reserve(session.owner, this.config, { ...input, feature });
    const controller = new AbortController(); this.active.set(job.id, { controller, owner: session.owner, publishing: false });
    const work = this.execute(job, sessionKey, controller).finally(() => { this.active.delete(job.id); this.pending.delete(work); });
    this.pending.add(work); return job;
  }
  async execute(job, sessionKey, controller) {
    const timeout = setTimeout(() => controller.abort(), 240_000);
    try {
      this.store.transition(job.id, job.owner, ['queued'], { state: 'running', message: 'Reading complete bounded repository snapshots.' });
      const session = this.store.get('session', sessionKey, job.owner); ensure(session, 401, 'session', 'Sign in again.');
      const selected = await this.github.authorize(session.token, job.input.sourceId, job.input.destinationId, controller.signal);
      const source = await this.github.readRepository(session.token, selected.source, controller.signal);
      const destination = await this.github.readRepository(session.token, selected.destination, controller.signal);
      controller.signal.throwIfAborted(); ensure(this.store.get('session', sessionKey, job.owner), 401, 'session', 'Session expired or was revoked.');
      const result = await this.draft(source.snapshot, destination.snapshot, job.input.feature, this.config, controller.signal);
      controller.signal.throwIfAborted(); ensure(this.store.get('session', sessionKey, job.owner), 401, 'session', 'Session expired or was revoked.');
      const { review, analysis } = result;
      ensure(review && typeof review.exportable === 'boolean', 502, 'draft', 'Draft provider returned an invalid review.');
      this.store.transition(job.id, job.owner, ['running'], { state: review.exportable ? 'review_ready' : 'blocked',
        message: review.exportable ? 'Review the draft. Project build and tests have not run.' : 'The transfer safety checks require review.',
        source: source.repository, destination: destination.repository, review, analysis, digest: reviewDigest(review),
        verification: { sourceBaseline: 'not_run', destinationBaseline: 'not_run', transferredTests: 'not_run', destinationRegression: 'not_run' } });
    } catch (e) {
      const current = this.store.get('job', job.id, job.owner);
      if (current && ['queued', 'running'].includes(current.state)) this.store.transition(job.id, job.owner, ['queued', 'running'], {
        state: controller.signal.aborted ? 'cancelled' : 'failed',
        message: controller.signal.aborted ? 'Cancelled or timed out. An already-started AI request may still be billed.' : e instanceof HttpError ? e.message : 'Draft generation failed. No repository was changed.',
        errorCode: e instanceof HttpError ? e.code : 'draft_failed' });
      if (e.code === 'github_auth') this.store.invalidate(job.owner);
    } finally { clearTimeout(timeout); }
  }
  owned(owner, id) { const j = this.store.get('job', id, owner); ensure(j, 404, 'not_found', 'Job not found.'); return j; }
  view(j, detailed = true) {
    return { id: j.id, state: j.state, feature: j.input.feature, createdAt: j.createdAt, updatedAt: j.updatedAt, expires: j.expires, message: j.message,
      errorCode: j.errorCode, digest: j.digest, delivery: j.delivery, verification: j.verification,
      ...(detailed ? { review: j.review, analysis: j.analysis } : {}) };
  }
  cancel(owner, id) {
    const j = this.owned(owner, id);
    ensure(!['publishing', 'delivered', 'delivery_uncertain'].includes(j.state), 409, 'delivery_started', 'Publication may already have created GitHub work. It cannot be silently cancelled or removed.');
    this.active.get(id)?.controller.abort();
    return this.store.transition(id, owner, ['queued', 'running', 'review_ready', 'blocked', 'failed', 'interrupted', 'cancelled'], { state: 'cancelled', message: 'Cancelled. No new work will be started.' });
  }
  publish(sessionKey, session, id, input) {
    const work = this.publishOnce(sessionKey, session, id, input).finally(() => this.pending.delete(work));
    this.pending.add(work); return work;
  }
  async publishOnce(sessionKey, session, id, input) {
    exactKeys(input, ['digest', 'acknowledgeUnverified', 'acknowledgeWorkflows']);
    ensure(this.config.writesEnabled, 403, 'writes_disabled', 'Pull request writes are disabled by the operator.');
    ensure(input.acknowledgeUnverified === true && input.acknowledgeWorkflows === true, 403, 'publish_consent', 'Acknowledge the unverified draft and possible GitHub workflow execution before publishing.');
    const current = this.owned(session.owner, id);
    ensure(current.review && typeof input.digest === 'string' && input.digest === current.digest && current.digest === reviewDigest(current.review), 409, 'review_changed', 'The reviewed draft changed. Review it again.');
    if (current.state === 'delivered') return current.delivery;
    const job = this.store.transition(id, session.owner, ['review_ready', 'delivery_uncertain'], { state: 'publishing', message: 'Publishing a draft PR. Do not edit its branch until this finishes.' });
    const controller = new AbortController(); this.active.set(id, { controller, owner: session.owner, publishing: true });
    const timer = setTimeout(() => controller.abort(), 120_000);
    try {
      ensure(this.store.get('session', sessionKey, session.owner), 401, 'session', 'Sign in again.');
      const result = await deliver({ job, token: session.token, github: this.github, signal: controller.signal, save: changed => {
        ensure(this.store.get('job', id, session.owner), 409, 'job_deleted', 'Job was removed.'); this.store.saveJob(changed);
      } });
      this.store.transition(id, session.owner, ['publishing'], { state: 'delivered', delivery: result, message: 'Draft pull request created. User-project tests have NOT run.' });
      return result;
    } catch (e) {
      if (this.store.get('job', id, session.owner)) this.store.transition(id, session.owner, ['publishing'], {
        state: 'delivery_uncertain', errorCode: e instanceof HttpError ? e.code : 'delivery_uncertain',
        message: (e instanceof HttpError ? e.message + ' ' : '') + 'Publication is incomplete or uncertain. Retry checks the same branch and PR; existing work is never overwritten.' });
      if (e.code === 'github_auth') this.store.invalidate(session.owner);
      throw e;
    } finally { clearTimeout(timer); this.active.delete(id); }
  }
  abortOwner(owner) { for (const item of this.active.values()) if (item.owner === owner) item.controller.abort(); }
  async close() { for (const item of this.active.values()) item.controller.abort(); await Promise.allSettled([...this.pending]); }
}
