/**
 * @file Request-scoped deadline, cancellation and progress for foreground MCP drafts.
 * No detached job is started: callers await each stage and dispose this scope.
 * Progress numbers count status updates, not completion percentages or test results.
 */
export const DRAFT_REQUEST_TIMEOUT_MS = 240_000;
export const DRAFT_AI_TIMEOUT_MS = 180_000;
const PROGRESS_INTERVAL_MS = 15_000;
const STAGES = Object.freeze({
  validating: 'Validating the transfer request',
  github_access: 'Checking GitHub access',
  reading: 'Reading the selected repositories',
  analyzing: 'Selecting feature and test context',
  quota: 'Checking the draft allowance',
  generating: 'Waiting for the AI draft',
  saving: 'Saving the validated review'
});

/**
 * Own a bounded draft request and observe SDK/HTTP cancellation without copying
 * any caller-supplied abort reason into errors, logs or progress notifications.
 * In-flight database statements cannot be rolled back by an AbortSignal; a save
 * can finish after a disconnect. No stage in this scope publishes repository code.
 */
export function createDraftExecution(context, requestSignal) {
  const controller = new AbortController();
  const parents = [context?.mcpReq?.signal, requestSignal].filter(Boolean);
  let timedOut = false, closed = false, stage = 'validating';
  let progress = 0, sending = false, heartbeat;
  const started = Date.now();
  const token = context?.mcpReq?._meta?.progressToken;
  const hasProgress = (typeof token === 'string' || (typeof token === 'number' && Number.isFinite(token))) &&
    typeof context?.mcpReq?.notify === 'function';

  /** Send a fixed stage label only; never expose repository names/code or secrets. */
  function report() {
    if (!hasProgress || closed || controller.signal.aborted || sending) return;
    sending = true;
    const elapsed = Math.max(0, Math.floor((Date.now() - started) / 1000));
    Promise.resolve().then(() => {
      if (closed || controller.signal.aborted) return;
      return context.mcpReq.notify({ method: 'notifications/progress', params: {
        progressToken: token, progress: ++progress,
        message: `${STAGES[stage]} (${elapsed}s elapsed; not a completion percentage).`
      } });
    }).catch(() => { /* Optional progress must not fail or restart a transfer. */ })
      .finally(() => { sending = false; });
  }

  /** Stop network work when the caller disconnects or cancels the MCP request. */
  function cancel() { controller.abort(new DOMException('Draft cancelled', 'AbortError')); }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException('Draft deadline exceeded', 'TimeoutError'));
  }, DRAFT_REQUEST_TIMEOUT_MS);
  timer.unref?.();
  for (const parent of parents) {
    if (parent.aborted) cancel();
    else parent.addEventListener('abort', cancel, { once: true });
  }
  if (hasProgress) {
    heartbeat = setInterval(report, PROGRESS_INTERVAL_MS);
    heartbeat.unref?.();
  }

  /**
   * Await a single stage, racing cancellation so a stalled service cannot keep the
   * tool handler waiting beyond its application budget. Guard invocation too:
   * work queued just before cancellation must not start a later AI call or save.
   */
  async function run(nextStage, work) {
    if (!Object.hasOwn(STAGES, nextStage)) throw new Error('Unknown draft stage');
    controller.signal.throwIfAborted();
    stage = nextStage;
    report();
    let abort;
    const stopped = new Promise((_, reject) => {
      abort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', abort, { once: true });
    });
    try {
      const pending = Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return work(controller.signal);
      });
      const result = await Promise.race([pending, stopped]);
      controller.signal.throwIfAborted();
      return result;
    } finally { controller.signal.removeEventListener('abort', abort); }
  }

  /** Release timers/listeners and abort remaining parallel reads on every exit. */
  function dispose() {
    closed = true;
    clearTimeout(timer);
    clearInterval(heartbeat);
    for (const parent of parents) parent.removeEventListener('abort', cancel);
    cancel();
  }

  return {
    run, dispose,
    get signal() { return controller.signal; },
    get stage() { return stage; },
    get timedOut() { return timedOut; },
    get cancelled() { return controller.signal.aborted && !timedOut; }
  };
}
