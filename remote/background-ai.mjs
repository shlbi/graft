/**
 * @file Bounded OpenAI background create/retrieve/cancel/delete transport.
 * store:false is explicit, but background execution still requires temporary provider storage for polling.
 * The caller must obtain that consent. No request is retried automatically and raw errors are never returned.
 */
import { DraftJobError } from './draft-job-errors.mjs';
const ROOT = 'https://api.openai.com/v1/responses';
const STATES = new Set(['queued','in_progress','completed','failed','incomplete','cancelled']);

/** Accept only server-saved opaque response IDs, never arbitrary URLs or paths from a tool caller. */
function responseId(id) {
  if (typeof id !== 'string' || !/^resp_[A-Za-z0-9_-]{1,200}$/.test(id)) throw new DraftJobError('provider_failed');
  return id;
}

/** Decode a bounded JSON body with fatal UTF-8 validation and cancellation during streaming. */
async function readJSON(response, signal) {
  if (!response.body) throw new DraftJobError('provider_failed');
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > 500000) throw new DraftJobError('provider_failed');
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Construct an injectable provider client; the key is never persisted in a job or returned to MCP. */
export function createBackgroundAI({ apiKey, fetchImpl = fetch }) {
  /** Execute a single operation; initiation ambiguity must not trigger a second potentially billable POST. */
  async function call(path, method, body, timeoutMs, starting = false) {
    if (typeof apiKey !== 'string' || !apiKey.trim()) throw new DraftJobError('provider_rejected');
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetchImpl(ROOT + path, {
        method, signal, redirect: 'error', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      if (method === 'DELETE' && response.status === 404) { await response.body?.cancel(); return { deleted: true }; }
      if (!response.ok) {
        await response.body?.cancel();
        const code = starting ? (response.status >= 400 && response.status < 500 ? 'provider_rejected' : 'submission_unknown') : response.status === 404 ? 'response_unavailable' : 'service_unavailable';
        throw new DraftJobError(code);
      }
      return await readJSON(response, signal);
    } catch (error) {
      if (error instanceof DraftJobError) throw error;
      throw new DraftJobError(starting ? 'submission_unknown' : 'service_unavailable');
    }
  }
  /** Submit asynchronously and return a handle, not a generated patch. No implicit data-retention opt-in. */
  async function start(payload, consent) {
    if (consent !== true) throw new DraftJobError('background_consent_required');
    let result;
    try { result = await call('', 'POST', { ...payload, store: false, background: true }, 12000, true); }
    catch (error) { throw new DraftJobError(error?.code === 'provider_rejected' ? 'provider_rejected' : 'submission_unknown'); }
    if (!result || !STATES.has(result.status)) throw new DraftJobError('submission_unknown');
    try { responseId(result.id); } catch { throw new DraftJobError('submission_unknown'); }
    return result;
  }
  /** Poll once. A missing/expired provider handle is a failure, never permission to restart generation. */
  async function retrieve(id) {
    responseId(id);
    const result = await call('/' + id, 'GET', undefined, 10000);
    if (result?.id !== id || !STATES.has(result?.status)) throw new DraftJobError('provider_failed');
    return result;
  }
  /** Best-effort explicit cancellation, followed by deletion; terminal cleanup remains visible until successful. */
  async function cleanup(id, cancel = false) {
    responseId(id);
    if (cancel) {
      // Completed responses may reject cancellation; DELETE is still attempted.
      await call('/' + id + '/cancel', 'POST', undefined, 5000).catch(() => {});
    }
    const result = await call('/' + id, 'DELETE', undefined, 5000);
    if (result?.deleted !== true) throw new DraftJobError('service_unavailable');
  }
  return { start, retrieve, cleanup };
}
