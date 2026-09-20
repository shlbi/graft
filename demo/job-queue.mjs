import { randomBytes } from 'node:crypto';

const unavailable = message => Object.assign(new Error(message), { statusCode: 503 });

/** Serial, bounded, in-memory demo queue. Reservations include bodies in flight.
 * close() rejects new work and waits for every accepted job, including work
 * submitted in the same tick. This is not a durable or untrusted worker runtime.
 */
export function createJobQueue({ run, maxJobs = 64, ttlMs = 300_000 } = {}) {
  if (typeof run !== 'function') throw new TypeError('run must be a function');
  if (!Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > 256) throw new RangeError('invalid maxJobs');
  if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 3_600_000) throw new RangeError('invalid ttlMs');
  const jobs = new Map();
  const reservations = new Set();
  const pending = [];
  let draining = null;
  let closing = false;
  let closePromise;
  let active = 0;

  function prune() {
    const cutoff = Date.now() - ttlMs;
    for (const [id, job] of jobs) {
      if ((job.state === 'complete' || job.state === 'failed') && job.updatedAt <= cutoff) jobs.delete(id);
    }
  }
  function publicJob(job) {
    if (!job) return undefined;
    const { id, name, size, state, createdAt, updatedAt } = job;
    const value = { id, name, size, state, createdAt, updatedAt };
    if (state === 'complete') value.result = structuredClone(job.result);
    if (state === 'failed') value.error = job.error;
    return value;
  }
  function drain() {
    if (draining) return draining;
    // Store the promise BEFORE invoking user work, even if the queue is empty.
    draining = Promise.resolve().then(async () => {
      while (pending.length) {
        const job = pending.shift();
        active = 1;
        job.state = 'running';
        job.updatedAt = Date.now();
        try {
          job.result = await run(job.name, job.content);
          job.state = 'complete';
        } catch (error) {
          job.error = error instanceof Error ? error.message : String(error);
          job.state = 'failed';
        } finally {
          job.content = '';
          job.updatedAt = Date.now();
          active = 0;
        }
      }
    }).finally(() => { draining = null; });
    return draining;
  }
  return {
    reserve() {
      prune();
      if (closing) throw unavailable('job queue is closing');
      if (jobs.size + reservations.size >= maxJobs) throw unavailable('demo job queue is full; wait for retained jobs to expire');
      const ticket = Symbol();
      reservations.add(ticket);
      return {
        release() { reservations.delete(ticket); },
        submit({ name, content, size }) {
          if (!reservations.delete(ticket)) throw unavailable('upload reservation is no longer valid');
          if (closing) throw unavailable('job queue is closing');
          if (typeof name !== 'string' || typeof content !== 'string' || !Number.isSafeInteger(size) || size < 1) {
            throw new TypeError('invalid queued upload');
          }
          const now = Date.now();
          const job = { id: randomBytes(12).toString('base64url'), name, content, size,
            state: 'queued', createdAt: now, updatedAt: now };
          jobs.set(job.id, job);
          pending.push(job);
          const accepted = publicJob(job);
          void drain();
          return accepted;
        },
      };
    },
    get(id) { prune(); return publicJob(jobs.get(id)); },
    stats() {
      prune();
      return { activeJobs: active, queuedJobs: pending.length, retainedJobs: jobs.size,
        receivingJobs: reservations.size, maxJobs };
    },
    close() {
      if (!closePromise) {
        closing = true;
        reservations.clear();
        closePromise = drain();
      }
      return closePromise;
    },
  };
}
