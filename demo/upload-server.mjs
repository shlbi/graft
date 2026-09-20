import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const DEFAULT_MAX_UPLOAD_BYTES = 1024 * 1024;
const DEFAULT_JOB_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_JOBS = 64;

function sendJson(response, status, value) {
  const payload = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(payload);
}

export function normalizeUploadName(raw) {
  const name = String(raw ?? '').trim();
  if (!name || name.length > 160) throw Object.assign(new Error('upload name must be 1-160 characters'), { statusCode: 400 });
  if (name === '.' || name === '..' || /[\\/\0\r\n]/.test(name)) {
    throw Object.assign(new Error('upload name must be a plain filename'), { statusCode: 400 });
  }
  return name;
}

export async function readBoundedUploadBody(request, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error(`upload exceeds ${maxBytes} bytes`), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!size) throw Object.assign(new Error('upload body cannot be empty'), { statusCode: 400 });
  return Buffer.concat(chunks);
}

function publicJob(job) {
  const base = {
    id: job.id,
    name: job.name,
    size: job.size,
    state: job.state,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
  if (job.state === 'complete') return { ...base, result: job.result };
  if (job.state === 'failed') return { ...base, error: job.error };
  return base;
}

/**
 * Minimal HTTP boundary around an already prepared upload feature.
 * Upload acceptance is decoupled from processing through an explicit bounded
 * in-memory job queue. This is a demo transport boundary, not a claim that the
 * transplanted feature itself provides durable queueing.
 */
export function createUploadHttpServer({
  uploadAndProcess,
  host = '127.0.0.1',
  port = 0,
  maxUploadBytes = DEFAULT_MAX_UPLOAD_BYTES,
  maxJobs = DEFAULT_MAX_JOBS,
  jobTtlMs = DEFAULT_JOB_TTL_MS,
} = {}) {
  if (typeof uploadAndProcess !== 'function') throw new TypeError('uploadAndProcess must be a function');
  if (!Number.isInteger(maxUploadBytes) || maxUploadBytes < 1 || maxUploadBytes > 8 * 1024 * 1024) {
    throw new RangeError('maxUploadBytes must be an integer between 1 and 8388608');
  }
  if (!Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > 256) throw new RangeError('maxJobs must be an integer between 1 and 256');
  if (!Number.isInteger(jobTtlMs) || jobTtlMs < 1_000 || jobTtlMs > 60 * 60 * 1000) {
    throw new RangeError('jobTtlMs must be an integer between 1000 and 3600000');
  }

  const jobs = new Map();
  const pending = [];
  let active = 0;
  let drainPromise = null;
  let closing = false;

  function pruneJobs(now = Date.now()) {
    for (const [id, job] of jobs) {
      if ((job.state === 'complete' || job.state === 'failed') && now - job.updatedAt >= jobTtlMs) jobs.delete(id);
    }
  }

  async function drainQueue() {
    if (drainPromise) return drainPromise;
    drainPromise = (async () => {
      while (pending.length) {
        const job = pending.shift();
        if (!job || !jobs.has(job.id)) continue;
        active++;
        job.state = 'running';
        job.updatedAt = Date.now();
        try {
          job.result = await uploadAndProcess(job.name, job.content);
          job.state = 'complete';
        } catch (error) {
          job.error = error instanceof Error ? error.message : String(error);
          job.state = 'failed';
        } finally {
          job.content = '';
          job.updatedAt = Date.now();
          active--;
        }
      }
    })().finally(() => { drainPromise = null; });
    return drainPromise;
  }

  function scheduleDrain() {
    setImmediate(() => void drainQueue());
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    try {
      pruneJobs();
      if (request.method === 'GET' && url.pathname === '/api/health') {
        sendJson(response, 200, { ok: true, activeJobs: active, queuedJobs: pending.length, retainedJobs: jobs.size, maxJobs, maxUploadBytes });
        return;
      }
      if (request.method === 'GET' && url.pathname.startsWith('/api/jobs/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/jobs/'.length));
        const job = jobs.get(id);
        if (!job) {
          sendJson(response, 404, { error: 'job not found or expired' });
          return;
        }
        sendJson(response, 200, publicJob(job));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/upload') {
        if (closing) {
          sendJson(response, 503, { error: 'server is closing' });
          return;
        }
        const origin = request.headers.origin;
        if (origin && origin !== `http://${request.headers.host}`) {
          sendJson(response, 403, { error: 'cross-origin upload rejected' });
          return;
        }
        if (jobs.size >= maxJobs) {
          sendJson(response, 503, { error: 'demo job queue is full; wait for retained jobs to expire' });
          return;
        }
        const name = normalizeUploadName(url.searchParams.get('name'));
        const body = await readBoundedUploadBody(request, maxUploadBytes);
        const now = Date.now();
        const id = randomBytes(12).toString('base64url');
        const job = {
          id, name, size: body.length, content: body.toString('utf8'),
          state: 'queued', createdAt: now, updatedAt: now,
        };
        jobs.set(id, job);
        pending.push(job);
        sendJson(response, 202, { ...publicJob(job), poll: `/api/jobs/${encodeURIComponent(id)}` });
        scheduleDrain();
        return;
      }
      sendJson(response, 404, { error: 'not found' });
    } catch (error) {
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      sendJson(response, status, { error: status === 500 ? `upload failed: ${error.message}` : error.message });
    }
  });

  return {
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      return server.address();
    },
    async close() {
      closing = true;
      if (server.listening) {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
      await drainPromise;
    },
  };
}
