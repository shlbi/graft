import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Fault, requireThat, featureText, snapshot, analyze } from './lib/core.mjs';
import { readPublicRepository } from './lib/github.mjs';
import { proposeWithAI } from './lib/ai.mjs';
import { demoRun } from './lib/demo.mjs';
const files = new Map([
  ['/', ['public/index.html', 'text/html; charset=utf-8']],
  ['/app.mjs', ['public/app.mjs', 'text/javascript; charset=utf-8']],
  ['/style.css', ['public/style.css', 'text/css; charset=utf-8']],
  ['/policy.mjs', ['lib/policy.mjs', 'text/javascript; charset=utf-8']]
]);
async function readBody(req) {
  requireThat(req.headers['content-type']?.split(';')[0] === 'application/json', 'Use application/json.', 415);
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; requireThat(size <= 2400000, 'Request too large. Use smaller directories.', 413); chunks.push(chunk); }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new Fault('Request body must be valid UTF-8 JSON.'); }
}
export function createApp({ apiKey = '', model = '', repositoryReader = readPublicRepository, aiProvider = proposeWithAI } = {}) {
  let active = 0;
  const server = http.createServer(async (req, res) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Request deadline exceeded.')), 110000);
    res.on('close', () => { clearTimeout(timeout); if (!res.writableEnded) controller.abort(); });
    const send = (status, body, type = 'application/json; charset=utf-8') => {
      if (res.destroyed || res.writableEnded) return;
      clearTimeout(timeout); res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });
      res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
    };
    let acquired = false;
    try {
      const port = server.address()?.port;
      requireThat([`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host), 'Untrusted Host header.', 403);
      requireThat(!req.headers.origin || req.headers.origin === `http://${req.headers.host}`, 'Cross-origin request denied.', 403);
      requireThat(!['cross-site', 'same-site'].includes(req.headers['sec-fetch-site']), 'Cross-site request denied.', 403);
      if (req.method === 'GET' && files.has(req.url)) {
        const [name, type] = files.get(req.url); return send(200, await readFile(new URL(name, import.meta.url)), type);
      }
      if (req.method === 'GET' && req.url === '/api/config') return send(200, { aiConfigured: Boolean(apiKey && model), model: model || null, localPreview: true });
      requireThat(req.method === 'POST' && ['/api/analyze', '/api/demo'].includes(req.url), 'Not found.', 404);
      requireThat(active < 2, 'Two jobs are already running. Cancel or finish one before starting another.', 429);
      active++; acquired = true;
      const body = await readBody(req);
      requireThat(body && typeof body === 'object' && !Array.isArray(body), 'Request body must be an object.');
      if (req.url === '/api/demo') return send(200, demoRun());
      const feature = featureText(body.feature);
      requireThat(typeof body.useAI === 'boolean', 'Specify whether AI should be used.');
      if (body.useAI) {
        requireThat(body.consent === true, 'Confirm code sharing before using AI.', 403);
        requireThat(apiKey && model, 'AI is not configured. Repository discovery and the sample work without an API key.', 503);
      }
      const resolve = async input => {
        requireThat(input && ['github', 'folder'].includes(input.kind), 'Choose a public GitHub repo or local folder.');
        if (input.kind === 'folder') return snapshot({ ...input.snapshot, revision: null });
        return repositoryReader(input.url, feature, { signal: controller.signal });
      };
      // Serial intake bounds GitHub requests; disconnect cancels upstream work.
      const source = await resolve(body.source), destination = await resolve(body.destination);
      controller.signal.throwIfAborted();
      const analysis = analyze(source, destination, feature);
      const review = body.useAI ? await aiProvider({ source, destination, context: analysis.context, consent: body.consent, apiKey, model, signal: controller.signal }) : null;
      const { context, ...publicAnalysis } = analysis;
      send(200, { mode: body.useAI ? 'ai-draft' : 'discovery', analysis: publicAnalysis, review });
    } catch (error) {
      const status = error instanceof Fault ? error.status : controller.signal.aborted || ['AbortError', 'TimeoutError'].includes(error.name) ? 408 : 502;
      send(status, { error: error instanceof Fault ? error.message : status === 408 ? 'Request cancelled or timed out. No repository was changed.' : 'The request failed. No repository was changed; check connectivity and retry.' });
    } finally { if (acquired) active--; clearTimeout(timeout); }
  });
  server.requestTimeout = 120000; server.headersTimeout = 10000;
  return server;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? 4318);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be an integer from 1024 through 65535.');
  const server = createApp({ apiKey: process.env.OPENAI_API_KEY, model: process.env.GRAFT_AI_MODEL });
  server.listen(port, '127.0.0.1', () => console.log(`Graft local web preview: http://127.0.0.1:${port}`));
  const close = () => { server.close(); server.closeAllConnections(); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
}
