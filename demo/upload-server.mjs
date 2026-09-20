import { createServer } from 'node:http';

const DEFAULT_MAX_UPLOAD_BYTES = 1024 * 1024;

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

function safeUploadName(raw) {
  const name = String(raw ?? '').trim();
  if (!name || name.length > 160) throw Object.assign(new Error('upload name must be 1-160 characters'), { statusCode: 400 });
  if (name === '.' || name === '..' || /[\\/\0\r\n]/.test(name)) {
    throw Object.assign(new Error('upload name must be a plain filename'), { statusCode: 400 });
  }
  return name;
}

async function readBody(request, maxBytes) {
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

/**
 * Minimal HTTP boundary around an already prepared upload feature.
 * The feature function is injected so this transport does not weaken Graft's
 * review/apply boundary or pretend HTTP concerns are part of transplantation.
 */
export function createUploadHttpServer({ uploadAndProcess, host = '127.0.0.1', port = 0, maxUploadBytes = DEFAULT_MAX_UPLOAD_BYTES } = {}) {
  if (typeof uploadAndProcess !== 'function') throw new TypeError('uploadAndProcess must be a function');
  if (!Number.isInteger(maxUploadBytes) || maxUploadBytes < 1 || maxUploadBytes > 8 * 1024 * 1024) {
    throw new RangeError('maxUploadBytes must be an integer between 1 and 8388608');
  }

  let active = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    try {
      if (request.method === 'GET' && url.pathname === '/api/health') {
        sendJson(response, 200, { ok: true, activeUploads: active, maxUploadBytes });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/upload') {
        const origin = request.headers.origin;
        if (origin && origin !== `http://${request.headers.host}`) {
          sendJson(response, 403, { error: 'cross-origin upload rejected' });
          return;
        }
        const name = safeUploadName(url.searchParams.get('name'));
        const body = await readBody(request, maxUploadBytes);
        active++;
        try {
          const result = await uploadAndProcess(name, body.toString('utf8'));
          sendJson(response, 201, { name, size: body.length, result });
        } finally {
          active--;
        }
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
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
