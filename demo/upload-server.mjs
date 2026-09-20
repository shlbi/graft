import { createServer } from 'node:http';
import { createJobQueue } from './job-queue.mjs';
import { assertLoopbackHost, decodeUploadText, isLocalRequest } from './http-boundary.mjs';

const DEFAULT_MAX_UPLOAD_BYTES = 1024 * 1024;
const DEFAULT_JOB_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_JOBS = 64;

function sendJson(response, status, value) {
  if (response.destroyed || response.writableEnded) return;
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
  if (name === '.' || name === '..' || /[\\/\x00-\x1f\x7f]/u.test(name)) {
    throw Object.assign(new Error('upload name must be a plain filename'), { statusCode: 400 });
  }
  return name;
}

export async function readBoundedUploadBody(request, maxBytes, { allowEmpty = false } = {}) {
  const chunks = [];
  let size = 0;
  try {
    // Keep the socket usable for the 413 response when stopping an oversized body.
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > maxBytes) throw Object.assign(new Error(`upload exceeds ${maxBytes} bytes`), { statusCode: 413 });
      chunks.push(chunk);
    }
    if (!size && !allowEmpty) throw Object.assign(new Error('upload body cannot be empty'), { statusCode: 400 });
    return Buffer.concat(chunks);
  } finally {
    if (!request.complete) request.resume();
  }
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

  assertLoopbackHost(host);
  const queue = createJobQueue({ run: uploadAndProcess, maxJobs, ttlMs: jobTtlMs });
  let closing = false;
  let closePromise;

  const server = createServer(async (request, response) => {
    try {
      if (!isLocalRequest(request)) { sendJson(response, 403, { error: 'non-local or cross-origin request rejected' }); return; }
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/api/health') {
        sendJson(response, 200, { ok: true, ...queue.stats(), maxUploadBytes });
        return;
      }
      if (request.method === 'GET' && url.pathname.startsWith('/api/jobs/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/jobs/'.length));
        const job = queue.get(id);
        if (!job) {
          sendJson(response, 404, { error: 'job not found or expired' });
          return;
        }
        sendJson(response, 200, job);
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
        const name = normalizeUploadName(url.searchParams.get('name'));
        const reservation = queue.reserve();
        try {
          const body = await readBoundedUploadBody(request, maxUploadBytes);
          if (closing) throw Object.assign(new Error('server is closing'), { statusCode: 503 });
          const job = reservation.submit({ name, size: body.length, content: decodeUploadText(body) });
          sendJson(response, 202, { ...job, poll: `/api/jobs/${encodeURIComponent(job.id)}` });
        } finally { reservation.release(); }
        return;
      }
      sendJson(response, 404, { error: 'not found' });
    } catch (error) {
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      sendJson(response, status, { error: status === 500 ? `upload failed: ${error.message}` : error.message });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;

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
      if (!closePromise) {
        closing = true;
        closePromise = (async () => {
          if (server.listening) {
            await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
          }
          await queue.close();
        })();
      }
      return closePromise;
    },
  };
}
