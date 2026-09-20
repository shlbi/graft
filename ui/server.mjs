import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyPreparedTransplant } from '../dist/transplant.js';
import { prepareDemoTransplant } from '../demo/graft-fixture.mjs';
import { serializeDemoReview } from '../demo/review-model.mjs';
import { verifyDemo } from '../demo/verify.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const MAX_BODY_BYTES = 4096;
const SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_SESSIONS = 8;
const staticRoutes = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
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

function summarizeApply(applied) {
  return {
    created: applied.created.map(file => file.path),
    updated: applied.updated.map(patch => patch.targetPath),
    preserved: [...applied.preserved],
  };
}

export function createReviewServer({ host = '127.0.0.1', port = 4173 } = {}) {
  const sessions = new Map();
  let busy = false;

  function pruneSessions(now = Date.now()) {
    for (const [id, session] of sessions) if (session.expiresAt <= now || session.consumed) sessions.delete(id);
    while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  }

  async function handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://localhost');
    try {
      if (request.method === 'GET' && url.pathname === '/api/review') {
        pruneSessions();
        const fixture = await prepareDemoTransplant({ integrate: true });
        const review = serializeDemoReview(fixture);
        const reviewId = randomBytes(18).toString('base64url');
        sessions.set(reviewId, {
          fixture,
          consumed: false,
          expiresAt: Date.now() + SESSION_TTL_MS,
        });
        sendJson(response, 200, { reviewId, review, expiresInSeconds: SESSION_TTL_MS / 1000 });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/approve') {
        const origin = request.headers.origin;
        if (origin && origin !== `http://${request.headers.host}`) {
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
          const applied = applyPreparedTransplant(
            session.fixture.prepared,
            session.fixture.sourceSnapshots,
            session.fixture.destinationSnapshots,
          );
          const verification = await verifyDemo({ cycles: 1 });
          sendJson(response, 200, {
            applied: summarizeApply(applied),
            verification,
          });
        } finally {
          busy = false;
        }
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
