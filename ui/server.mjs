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
import { createJobQueue } from '../demo/job-queue.mjs';
import { assertLoopbackHost, decodeUploadText, isLocalRequest } from '../demo/http-boundary.mjs';

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
  if (response.destroyed || response.writableEnded) return;
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
  const bytes = await readBoundedUploadBody(request, MAX_BODY_BYTES, { allowEmpty: true });
  if (!bytes.length) return {};
  try {
    return JSON.parse(decodeUploadText(bytes));
  } catch {
    throw Object.assign(new Error('request body must be valid JSON'), { statusCode: 400 });
  }
}

function summarizeApply(applied) {
  return {
    created: applied.created.map(file => file.path),
    updated: applied.updated.map(patch => patch.targetPath),
    preserved: [...applied.preserved],
  };
}

export function createReviewServer({ host = '127.0.0.1', port = 4173 } = {}) {
  assertLoopbackHost(host);
  const sessions = new Map();
  let closing = false;
  let closePromise;
  let busy = false;
  let demoRuntime = null;

  function pruneSessions(now = Date.now()) {
    for (const [id, session] of sessions) if (session.expiresAt <= now || session.consumed) sessions.delete(id);
  }

  async function closeDemoRuntime(expected = demoRuntime) {
    if (!expected || expected !== demoRuntime) return;
    demoRuntime = null; // Revoke new uploads before awaiting accepted jobs.
    clearTimeout(expected.expiryTimer);
    await expected.queue.close();
    await expected.runtime.close();
  }

  async function pruneDemoRuntime(now = Date.now()) {
    if (demoRuntime && demoRuntime.expiresAt <= now) await closeDemoRuntime();
  }

  async function handle(request, response) {
    try {
      if (closing) { sendError(response, 503, 'server is closing'); return; }
      if (!isLocalRequest(request)) { sendError(response, 403, 'non-local or cross-origin request rejected'); return; }
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/api/review') {
        pruneSessions();
        await pruneDemoRuntime();
        const fixture = await prepareDemoTransplant({ integrate: true });
        const review = serializeDemoReview(fixture);
        const reviewId = randomBytes(18).toString('base64url');
        pruneSessions();
        while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
        sessions.set(reviewId, { fixture, consumed: false, expiresAt: Date.now() + SESSION_TTL_MS });
        sendJson(response, 200, { reviewId, review, expiresInSeconds: SESSION_TTL_MS / 1000 });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/approve') {
        if (!isLocalRequest(request)) {
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
          // Revalidate actual input bytes, but never apply the newly generated plan.
          const actual = await prepareDemoTransplant({ integrate: true });
          const approvedFixture = { ...actual, prepared: session.fixture.prepared };
          const applied = applyPreparedTransplant(approvedFixture.prepared, actual.sourceSnapshots, actual.destinationSnapshots);
          const verification = await verifyDemo({ cycles: 1, fixture: approvedFixture });
          await closeDemoRuntime();
          const runtime = await createCompiledTransplantFeature({ fixture: approvedFixture });
          const token = randomBytes(18).toString('base64url');
          demoRuntime = { token, runtime, expiresAt: Date.now() + UPLOAD_DEMO_TTL_MS,
            queue: createJobQueue({ run: runtime.uploadAndProcess, maxJobs: MAX_DEMO_JOBS, ttlMs: UPLOAD_DEMO_TTL_MS }) };
          const owned = demoRuntime;
          owned.expiryTimer = setTimeout(() => { void closeDemoRuntime(owned).catch(console.error); }, UPLOAD_DEMO_TTL_MS);
          owned.expiryTimer.unref();
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
        if (!isLocalRequest(request)) {
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
        const job = demoRuntime.queue.get(id);
        if (!job) {
          sendError(response, 404, 'demo job not found or expired');
          return;
        }
        sendJson(response, 200, job);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/demo-upload') {
        if (!isLocalRequest(request)) {
          sendError(response, 403, 'cross-origin upload rejected');
          return;
        }
        await pruneDemoRuntime();
        const token = request.headers['x-graft-upload-token'];
        if (!demoRuntime || typeof token !== 'string' || token !== demoRuntime.token) {
          sendError(response, 403, 'a current approved upload-demo token is required');
          return;
        }
        if (busy) { sendError(response, 409, 'runtime is being replaced; retry after verification'); return; }
        const owned = demoRuntime;
        const name = normalizeUploadName(url.searchParams.get('name'));
        const reservation = owned.queue.reserve();
        try {
          const body = await readBoundedUploadBody(request, MAX_UPLOAD_BYTES);
          if (closing || busy || owned !== demoRuntime || owned.expiresAt <= Date.now()) {
            sendError(response, 409, 'approved runtime changed while receiving upload');
            return;
          }
          const job = reservation.submit({ name, size: body.length, content: decodeUploadText(body) });
          sendJson(response, 202, { ...job, poll: `/api/demo-jobs/${encodeURIComponent(job.id)}` });
        } finally { reservation.release(); }
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
  server.requestTimeout = 60_000;
  server.headersTimeout = 15_000;
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
      if (!closePromise) {
        closing = true;
        closePromise = (async () => {
          if (server.listening) {
            await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
          }
          await closeDemoRuntime();
          sessions.clear();
        })();
      }
      return closePromise;
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createReviewServer();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => { void app.close().catch(error => { console.error(error); process.exitCode = 1; }); });
  }
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
