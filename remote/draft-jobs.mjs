/**
 * @file Client-driven durable draft state machine. Each tool call performs at most one bounded step.
 * No process-local queue, detached promise, timer worker, or long-held MCP request is required.
 * OpenAI owns background generation; an authenticated poll advances preparation/submission/finalization.
 */
import { createHash } from 'node:crypto';
import { DraftJobError, JOB_MESSAGES } from './draft-job-errors.mjs';
import { MAX_REPAIR_ATTEMPTS, repairProgress, validationDiagnostic, repairFeedback, canRepair } from './draft-repair.mjs';
import { PROPOSAL_RULES } from '../web/lib/proposal-contract.mjs';
import { normalizeSelection } from '../web/lib/feature-plan.mjs';
const TERMINAL = new Set(['completed','failed','cancelled']);
const PROVIDER_WINDOW_MS = 8 * 60 * 1000;

/** Validate two repository names and a stable client retry key before persistence or paid work. */
export function draftRequest(args, validateFeature = value => value.trim()) {
  if (args?.allowAI !== true || args?.allowBackgroundProcessing !== true) throw new DraftJobError('background_consent_required');
  const repo = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(value) && !['.','..'].includes(value.split('/')[1]);
  if (!repo(args.sourceRepo) || !repo(args.destinationRepo) || args.sourceRepo.toLowerCase() === args.destinationRepo.toLowerCase() ||
      typeof args.feature !== 'string' || args.feature.trim().length < 3 || args.feature.length > 1500 ||
      typeof args.requestKey !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(args.requestKey)) throw new DraftJobError('invalid_request');
  const maxRepairAttempts = args.maxRepairAttempts === undefined ? MAX_REPAIR_ATTEMPTS : args.maxRepairAttempts;
  if (!Number.isInteger(maxRepairAttempts) || maxRepairAttempts < 0 || maxRepairAttempts > MAX_REPAIR_ATTEMPTS) throw new DraftJobError('invalid_request');
  const request = { maxRepairAttempts, sourceRepo: args.sourceRepo.toLowerCase(), destinationRepo: args.destinationRepo.toLowerCase(), feature: validateFeature(args.feature), allowAI: true, allowBackgroundProcessing: true };
  try {
    for (const key of ['sourcePaths', 'destinationPaths']) {
      const selected = normalizeSelection(args[key]);
      if (selected) request[key] = selected;
    }
  } catch { throw new DraftJobError('invalid_request'); }
  const { maxRepairAttempts: _budget, ...legacyRequest } = request;
  return { request, requestKey: args.requestKey, requestHash: createHash('sha256').update(JSON.stringify(request)).digest('hex'),
    legacyRequestHash: createHash('sha256').update(JSON.stringify(legacyRequest)).digest('hex') };

}

/** Return only opaque job/review handles and truthful progress; no snapshots, provider IDs, lease tokens or keys. */
export function draftJobStatus(row, progress = null) {
  const terminal = TERMINAL.has(row.state);
  const errorCode = Object.hasOwn(JOB_MESSAGES, row.error_code) ? row.error_code : 'service_unavailable';
  return {
    jobId: row.id, requestKey: row.request_key, status: row.state, cancelRequested: row.cancel_requested,
    ...(row.review_id ? { reviewId: row.review_id } : {}),
    ...(row.error_code ? { [terminal ? 'error' : 'validation']: { code: errorCode, message: JOB_MESSAGES[errorCode] } } : {}),
    ...(progress ? { generation: progress } : {}),
    stage: !terminal && row.error_code ? 'adjusting_integration' : row.state,
    continueAutomatically: !terminal,
    repairBudgetExhausted: row.state === 'failed' && (row.error_code === 'repair_budget_exhausted' ||
      (Object.hasOwn(PROPOSAL_RULES, row.error_code) && PROPOSAL_RULES[row.error_code].repairable)),
    providerCleanupPending: row.cleanup_pending,
    nextTool: row.state === 'completed' ? 'repot_review' : terminal ? null : 'repot_draft_status',
    pollAfterSeconds: terminal ? null : row.state === 'running' ? 5 : 1,
    retryAutomatically: false,
    notice: row.state === 'completed' ? 'A review is saved, not a verified integration. Read it and check exportable before explicit publication.' :
      terminal ? 'No repository changes were made. Do not replace the requested feature or submit a new job without user approval.' :
      row.error_code ? 'Adjusting the integration within this job’s approved repair budget. Continue repot_draft_status; no new user approval or new requestKey is needed. Do not switch features.' :
      'Resume this jobId with repot_draft_status. Generation and targeted repairs stay within the saved per-job attempt budget. Each attempt consumes the existing draft allowance; status polls do not regenerate. Do not start a new job or substitute another feature.'
  };
}

/** Construct orchestration with replaceable I/O for executable failure/race/restart tests. */
export function createDraftJobs({ store, provider, prepare, buildRequest, reviewResponse, validateFeature, now = Date.now }) {
  /** Expose only numeric repair progress after the store has checked job ownership. */
  function view(row) {
    return draftJobStatus(row, row.payload ? repairProgress(store.context(row), row.charged) : null);
  }

  /** Start cheaply: persist intent and return a durable job ID before reading repos or waiting for a model. */
  async function start(userId, args) {
    if (typeof userId !== 'string' || !userId) throw new DraftJobError('job_not_found');
    const normalized = draftRequest(args, validateFeature);
    return view(await store.create(userId, normalized.requestKey, normalized.requestHash, normalized.request, normalized.legacyRequestHash));
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
    if (TERMINAL.has(current.state)) { await cleanup(current); return view(await store.get(userId, jobId)); }
    const claimed = await store.claim(userId, jobId);
    if (!claimed) return view(await store.get(userId, jobId));
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
        if (prepared.context?.integrationPlan?.contextCoverage?.complete === false || prepared.context?.integrationPlan?.metadataTruncated) throw new DraftJobError('context_budget_exceeded');
        current = await store.prepared(claimed, { ...value, ...prepared });
      } else if (phase === 'prepared' && claimed.response_id) {
        // Separate short cleanup step before another billable attempt. Failure is
        // recoverable by polling this job, never by starting a duplicate generation.
        try { await provider.cleanup(claimed.response_id, false); }
        catch { throw new DraftJobError('service_unavailable'); }
        current = await store.repairCleaned(claimed);
      } else if (phase === 'prepared') {
        const value = store.context(claimed);
        // Build/validate before marking dispatch, so local preparation failures never spend quota.
        const payload = buildRequest(value);
        const dispatched = await store.beginSubmission(claimed);
        if (!dispatched) return view(await store.get(userId, jobId));
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
            let review, failure, rejected = false;
            try {
              review = await reviewResponse(response, value);
              if (!review || typeof review !== 'object') throw new Error('Invalid validator result');
            } catch (error) { rejected = true; failure = error; }
            if (rejected) {
              const diagnostic = validationDiagnostic(failure);
              if (canRepair(value, failure, claimed.charged)) {
                current = await store.queueRepair(claimed, repairFeedback(failure));
              } else {
                // Keep the exact fixed rule in error_code even after clearing the
                // discarded source context. Unknown engine bugs are distinct.
                current = await store.finish(claimed, 'failed', diagnostic.code);
              }
            } else {
              review.generation = { ...repairProgress(value, claimed.charged),
                validationHistory: (value.generation?.diagnostics ?? []).map(d => ({ code: d.code, changeIndex: d.changeIndex })) };
              current = await store.complete(claimed, value, review);
            }
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
    return view(await store.get(userId, jobId));
  }
  /** Cancel persistently; a currently leased worker observes the flag before finalization. */
  async function cancel(userId, jobId) {
    await store.requestCancel(userId, jobId);
    return status(userId, jobId);
  }
  return { start, status, cancel };
}
