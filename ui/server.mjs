import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyPreparedTransplant } from '../dist/transplant.js';
import { prepareDemoTransplant } from '../demo/graft-fixture.mjs';
import { createCompiledTransplantFeature } from '../demo/http-transplant.mjs';
import { serializeDemoReview } from '../demo/review-model.mjs';
import { normalizeUploadName, readBoundedUploadBody } from '../demo/upload-server.mjs';
import { verifyDemo } from '../demo/verify.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const MAX_BODY_BYTES = 4096;
const MAX_UPLOAD_BYTES = 1024 * 1024;
const SESSION_TTL_MS = 10 * 60 * 1000;
const UPLOAD_DEMO_TTL_MS = 5 * 60 * 1000;
const MAX_SESSIONS = 8;
const MAX_DEMO_JOBS = 8;
const staticRoutes = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/upload.css', ['upload.css', 'text/css; charset=utf-8']],
]);

function sendJson(response, status, value) {
  const payload = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  response.end(payload);
}

function sendError(response, status, message) {
  sendJson(response, status, { error: message });
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('request body too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('request body must be valid JSON'), { statusCode: 400 });
  }
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  return !origin || origin === `http://${request.headers.host}`;
}

function summarizeApply(applied) {
  return {
    created: applied.created.map(file => file.path),
    updated: applied.updated.map(patch => patch.targetPath),
    preserved: [...applied.preserved],
  };
}

function publicDemoJob(job) {
  const value = {
    id: job.id,
    name: job.name,
    size: job.size,
    state: job.state,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
  if (job.state === 'complete') return { ...value, result: job.result };
  if (job.state === 'failed') return { ...value, error: job.error };
  return value;
}

export function createReviewServer({ host = '127.0.0.1', port = 4173 } = {}) {
  const sessions = new Map();
  const demoJobs = new Map();
  const demoQueue = [];
  let busy = false;
  let demoDrainPromise = null;
  let demoRuntime = null;

  function pruneSessions(now = Date.now()) {
    for (const [id, session] of sessions) if (session.expiresAt <= now || session.consumed) sessions.delete(id);
    while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  }

  function pruneDemoJobs(now = Date.now()) {
    for (const [id, job] of demoJobs) {
      if ((job.state === 'complete' || job.state === 'failed') && now - job.updatedAt >= UPLOAD_DEMO_TTL_MS) demoJobs.delete(id);
    }
  }

  async function drainDemoQueue() {
    if (demoDrainPromise) return demoDrainPromise;
    demoDrainPromise = (async () => {
      while (demoQueue.length) {
        const job = demoQueue.shift();
        if (!job || !demoJobs.has(job.id)) continue;
        if (!demoRuntime || demoRuntime.token !== job.runtimeToken || demoRuntime.expiresAt <= Date.now()) {
          job.state = 'failed';
          job.error = 'approved upload runtime expired before processing';
          job.content = '';
          job.updatedAt = Date.now();
          continue;
        }
        job.state = 'running';
        job.updatedAt = Date.now();
        try {
          job.result = await demoRuntime.runtime.uploadAndProcess(job.name, job.content);
          job.state = 'complete';
        } catch (error) {
          job.state = 'failed';
          job.error = error instanceof Error ? error.message : String(error);
        } finally {
          job.content = '';
          job.updatedAt = Date.now();
        }
      }
    })().finally(() => { demoDrainPromise = null; });
    return demoDrainPromise;
  }

  function scheduleDemoDrain() {
    setImmediate(() => void drainDemoQueue());
  }

  async function closeDemoRuntime() {
    await demoDrainPromise;
    const current = demoRuntime;
    demoRuntime = null;
    demoQueue.length = 0;
    demoJobs.clear();
    if (current) await current.runtime.close();
  }

  async function pruneDemoRuntime(now = Date.now()) {
    pruneDemoJobs(now);
    if (demoRuntime && demoRuntime.expiresAt <= now) await closeDemoRuntime();
  }

  async function handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://localhost');
    try {
      if (request.method === 'GET' && url.pathname === '/api/review') {
        pruneSessions();
        await pruneDemoRuntime();
        const fixture = await prepareDemoTransplant({ integrate: true });
        const review = serializeDemoReview(fixture);
        const reviewId = randomBytes(18).toString('base64url');
        sessions.set(reviewId, { fixture, consumed: false, expiresAt: Date.now() + SESSION_TTL_MS });
        sendJson(response, 200, { reviewId, review, expiresInSeconds: SESSION_TTL_MS / 1000 });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/approve') {
        if (!sameOrigin(request)) {
          sendError(response, 403, 'cross-origin approval rejected');
          return;
        }
        const body = await readJson(request);
        if (!body || typeof body !== 'object' || body.approved !== true || typeof body.reviewId !== 'string') {
          sendError(response, 400, 'explicit approved=true and a reviewId are required');
          return;
        }
        pruneSessions();
        const session = sessions.get(body.reviewId);
        if (!session) {
          sendError(response, 404, 'review session missing or expired; prepare a fresh review');
          return;
        }
        if (session.consumed) {
          sendError(response, 409, 'review session was already consumed');
          return;
        }
        if (busy) {
          sendError(response, 409, 'another verification is already running');
          return;
        }
        busy = true;
        session.consumed = true;
        try {
          const applied = applyPreparedTransplant(session.fixture.prepared, session.fixture.sourceSnapshots, session.fixture.destinationSnapshots);
          const verification = await verifyDemo({ cycles: 1 });
          await closeDemoRuntime();
          const runtime = await createCompiledTransplantFeature();
          const token = randomBytes(18).toString('base64url');
          demoRuntime = { token, runtime, expiresAt: Date.now() + UPLOAD_DEMO_TTL_MS };
          sendJson(response, 200, {
            applied: summarizeApply(applied),
            verification,
            uploadDemo: {
              token,
              expiresInSeconds: UPLOAD_DEMO_TTL_MS / 1000,
              maxUploadBytes: MAX_UPLOAD_BYTES,
              accepted: 'UTF-8 text-like files sent as a raw bounded request body',
              mode: 'explicit queued job with polling',
            },
          });
        } finally {
          busy = false;
        }
        return;
      }

      if (request.method === 'GET' && url.pathname.startsWith('/api/demo-jobs/')) {
        if (!sameOrigin(request)) {
          sendError(response, 403, 'cross-origin job polling rejected');
          return;
        }
        await pruneDemoRuntime();
        const token = request.headers['x-graft-upload-token'];
        if (!demoRuntime || typeof token !== 'string' || token !== demoRuntime.token) {
          sendError(response, 403, 'a current approved upload-demo token is required');
          return;
        }
        const id = decodeURIComponent(url.pathname.slice('/api/demo-jobs/'.length));
        const job = demoJobs.get(id);
        if (!job || job.runtimeToken !== token) {
          sendError(response, 404, 'demo job not found or expired');
          return;
        }
        sendJson(response, 200, publicDemoJob(job));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/demo-upload') {
        if (!sameOrigin(request)) {
          sendError(response, 403, 'cross-origin upload rejected');
          return;
        }
        await pruneDemoRuntime();
        const token = request.headers['x-graft-upload-token'];
        if (!demoRuntime || typeof token !== 'string' || token !== demoRuntime.token) {
          sendError(response, 403, 'a current approved upload-demo token is required');
          return;
        }
        pruneDemoJobs();
        if (demoJobs.size >= MAX_DEMO_JOBS) {
          sendError(response, 503, 'demo job queue is full; wait for retained jobs to expire');
          return;
        }
        const name = normalizeUploadName(url.searchParams.get('name'));
        const body = await readBoundedUploadBody(request, MAX_UPLOAD_BYTES);
        const now = Date.now();
        const id = randomBytes(12).toString('base64url');
        const job = {
          id,
          name,
          size: body.length,
          state: 'queued',
          createdAt: now,
          updatedAt: now,
          runtimeToken: token,
          content: body.toString('utf8'),
        };
        demoJobs.set(id, job);
        demoQueue.push(job);
        sendJson(response, 202, { ...publicDemoJob(job), poll: `/api/demo-jobs/${encodeURIComponent(id)}` });
        scheduleDemoDrain();
        return;
      }

      const asset = staticRoutes.get(url.pathname);
      if (request.method === 'GET' && asset) {
        const [filename, contentType] = asset;
        const content = await readFile(join(here, filename));
        response.writeHead(200, {
          'content-type': contentType,
          'content-length': content.length,
          'cache-control': 'no-store',
          'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
          'x-content-type-options': 'nosniff',
        });
        response.end(content);
        return;
      }

      sendError(response, 404, 'not found');
    } catch (error) {
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      sendError(response, status, status === 500 ? `operation failed: ${error.message}` : error.message);
    }
  }

  const server = createServer((request, response) => void handle(request, response));
  return {
    async listen() {
      await new Promise((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolveListen();
        });
      });
      return server.address();
    },
    async close() {
      await closeDemoRuntime();
      if (!server.listening) return;
      await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createReviewServer();
  app.listen().then(address => {
    const host = typeof address === 'object' && address ? address.address : '127.0.0.1';
    const port = typeof address === 'object' && address ? address.port : 4173;
    console.log(`Graft review console: http://${host}:${port}`);
    console.log('Review is read-only until Approve & Verify is explicitly pressed.');
  }).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
