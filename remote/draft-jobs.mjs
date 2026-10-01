/**
 * @file Client-driven durable draft state machine. Each tool call performs at most one bounded step.
 * No process-local queue, detached promise, timer worker, or long-held MCP request is required.
 * OpenAI owns background generation; an authenticated poll advances preparation/submission/finalization.
 */
import { createHash } from 'node:crypto';
import { DraftJobError, JOB_MESSAGES } from './draft-job-errors.mjs';
const TERMINAL = new Set(['completed','failed','cancelled']);
const PROVIDER_WINDOW_MS = 8 * 60 * 1000;

/** Validate two repository names and a stable client retry key before persistence or paid work. */
export function draftRequest(args, validateFeature = value => value.trim()) {
  if (args?.allowAI !== true || args?.allowBackgroundProcessing !== true) throw new DraftJobError('background_consent_required');
  const repo = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(value) && !['.','..'].includes(value.split('/')[1]);
  if (!repo(args.sourceRepo) || !repo(args.destinationRepo) || args.sourceRepo.toLowerCase() === args.destinationRepo.toLowerCase() ||
      typeof args.feature !== 'string' || args.feature.trim().length < 3 || args.feature.length > 1500 ||
      typeof args.requestKey !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(args.requestKey)) throw new DraftJobError('invalid_request');
  const request = { sourceRepo: args.sourceRepo.toLowerCase(), destinationRepo: args.destinationRepo.toLowerCase(), feature: validateFeature(args.feature), allowAI: true, allowBackgroundProcessing: true };
  return { request, requestKey: args.requestKey, requestHash: createHash('sha256').update(JSON.stringify(request)).digest('hex') };
}

/** Return only opaque job/review handles and truthful progress; no snapshots, provider IDs, lease tokens or keys. */
export function draftJobStatus(row) {
  const terminal = TERMINAL.has(row.state);
  return {
    jobId: row.id, requestKey: row.request_key, status: row.state, cancelRequested: row.cancel_requested,
    ...(row.review_id ? { reviewId: row.review_id } : {}),
    ...(row.error_code ? { error: { code: row.error_code, message: JOB_MESSAGES[row.error_code] ?? JOB_MESSAGES.service_unavailable } } : {}),
    providerCleanupPending: row.cleanup_pending,
    nextTool: row.state === 'completed' ? 'repot_review' : terminal ? null : 'repot_draft_status',
    pollAfterSeconds: terminal ? null : row.state === 'running' ? 5 : 1,
    retryAutomatically: false,
    notice: row.state === 'completed' ? 'A review is saved, not a verified integration. Read it and check exportable before explicit publication.' :
      terminal ? 'No repository changes were made. Do not replace the requested feature or submit a new job without user approval.' :
      'Resume this jobId with repot_draft_status. Do not call repot_draft again with a new requestKey or substitute a smaller feature. Preparation/submission advance on polls; generation runs at the provider.'
  };
}

/** Construct orchestration with replaceable I/O for executable failure/race/restart tests. */
export function createDraftJobs({ store, provider, prepare, buildRequest, reviewResponse, validateFeature, now = Date.now }) {
  /** Start cheaply: persist intent and return a durable job ID before reading repos or waiting for a model. */
  async function start(userId, args) {
    if (typeof userId !== 'string' || !userId) throw new DraftJobError('job_not_found');
    const normalized = draftRequest(args, validateFeature);
    return draftJobStatus(await store.create(userId, normalized.requestKey, normalized.requestHash, normalized.request));
  }
  /** Cleanup is best-effort and never creates a new generation or claims remote deletion that failed. */
  async function cleanup(row) {
    if (!row.cleanup_pending || !row.response_id) return;
    try { await provider.cleanup(row.response_id, row.state !== 'completed'); await store.cleaned(row.user_id, row.id); }
    catch { /* The persisted cleanup flag lets later status/cancel calls retry without hiding failure. */ }
  }
  /** Race preparation against a short deadline and stop downstream work after a disconnected/expired read. */
  async function prepareStep(request, userId) {
    const controller = new AbortController();
    let rejectDeadline;
    const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
    const timer = setTimeout(() => { controller.abort(); rejectDeadline(new DraftJobError('preparation_failed')); }, 20000);
    try {
      return await Promise.race([Promise.resolve().then(() => prepare(request, userId, controller.signal)), deadline]);
    } finally { clearTimeout(timer); controller.abort(); }
  }
  /**
   * Advance one stage only. Once dispatch intent is committed, a process crash or lost acknowledgement
   * becomes submission_unknown, never an automatic billable retry. Cancellation is an explicit tool.
   */
  async function status(userId, jobId) {
    let current = await store.get(userId, jobId);
    if (TERMINAL.has(current.state)) { await cleanup(current); return draftJobStatus(await store.get(userId, jobId)); }
    const claimed = await store.claim(userId, jobId);
    if (!claimed) return draftJobStatus(await store.get(userId, jobId));
    let phase = claimed.state, acceptedResponseId;
    try {
      if (claimed.cancel_requested) {
        current = await store.finish(claimed, 'cancelled', claimed.state === 'submitting' && !claimed.response_id ? 'submission_unknown' : null);
      } else if (new Date(claimed.expires_at).getTime() <= now()) {
        current = await store.finish(claimed, 'failed', 'job_expired');
      } else if (phase === 'queued') {
        const value = store.context(claimed);
        let prepared;
        try { prepared = await prepareStep(value.request, userId); }
        catch { throw new DraftJobError('preparation_failed'); }
        current = await store.prepared(claimed, { ...value, ...prepared });
      } else if (phase === 'prepared') {
        const value = store.context(claimed);
        // Build/validate before marking dispatch, so local preparation failures never spend quota.
        const payload = buildRequest(value);
        const dispatched = await store.beginSubmission(claimed);
        if (!dispatched) return draftJobStatus(await store.get(userId, jobId));
        phase = 'submitting';
        const response = await provider.start(payload, value.request.allowBackgroundProcessing);
        acceptedResponseId = response.id;
        current = await store.running(claimed, acceptedResponseId);
        // Even immediate completion is finalized on the next poll with the saved handle.
      } else if (phase === 'submitting') {
        // This state is claimable only after the previous lease expired. Never send a second POST.
        current = await store.finish(claimed, 'failed', 'submission_unknown');
      } else if (phase === 'running') {
        if (!claimed.provider_started_at || now() - new Date(claimed.provider_started_at).getTime() >= PROVIDER_WINDOW_MS) {
          current = await store.finish(claimed, 'failed', 'response_unavailable');
        } else {
          const response = await provider.retrieve(claimed.response_id);
          if (response.status === 'completed') {
            const value = store.context(claimed);
            let review;
            try { review = reviewResponse(response, value); }
            catch { throw new DraftJobError('invalid_proposal'); }
            current = await store.complete(claimed, value, review);
          } else if (response.status === 'queued' || response.status === 'in_progress') current = claimed;
          else current = await store.finish(claimed, response.status === 'cancelled' ? 'cancelled' : 'failed', 'provider_failed');
        }
      }
    } catch (error) {
      // A transient poll or database failure leaves the SAME provider handle recoverable.
      const known = error instanceof DraftJobError && !['service_unavailable','setup_required','job_not_found'].includes(error.code);
      if (acceptedResponseId) {
        // Repeating this owner/lease-bound DB write is safe; never repeat the provider POST.
        // This also handles a committed ID whose database acknowledgement was lost.
        current = await store.running(claimed, acceptedResponseId);
      } else if (known) current = await store.finish(claimed, 'failed', error.code);
      else if (phase === 'submitting') current = await store.finish(claimed, 'failed', 'submission_unknown');
      else throw error;
    } finally { await store.release(claimed).catch(() => {}); }
    current = await store.get(userId, jobId);
    // Cancellation that raced a completed prepare/submit/finalize is observed on the next short poll.
    if (TERMINAL.has(current.state)) await cleanup(current);
    return draftJobStatus(await store.get(userId, jobId));
  }
  /** Cancel persistently; a currently leased worker observes the flag before finalization. */
  async function cancel(userId, jobId) {
    await store.requestCancel(userId, jobId);
    return status(userId, jobId);
  }
  return { start, status, cancel };
}
