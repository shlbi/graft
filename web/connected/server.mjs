import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Store } from './store.mjs';
import { GitHubClient } from './github.mjs';
import { Service } from './service.mjs';
import { readConfig, opaque, sha256, equal, HttpError, ensure, cookie, cookieName, readCookie, checkOrigin, jsonBody, bodyBytes, limiter, verifyWebhook } from './security.mjs';
const staticFiles = new Map([['/', ['index.html', 'text/html']], ['/app.mjs', ['app.mjs', 'text/javascript']], ['/style.css', ['style.css', 'text/css']]]);
const identity = x => typeof x === 'string' && /^[A-Za-z0-9_-]{43}$/.test(x);
export function createConnectedApp({ config, store = new Store(config.database, config.dataKey), github = new GitHubClient(config), draft } = {}) {
  const service = new Service(store, github, config, { draft });
  const limit = limiter({ max: 120 }), loginLimit = limiter({ max: 10, windowMs: 600_000 });
  let requests = 0;
  const server = http.createServer({ maxHeaderSize: 16_384 }, async (req, res) => {
    const requestId = opaque().slice(0, 12), abort = new AbortController();
    const timer = setTimeout(() => { abort.abort(); req.destroy(); res.destroy(); }, 125_000);
    const disconnected = () => { if (!res.writableEnded) abort.abort(); };
    res.on('close', disconnected);
    const send = (status, body, headers = {}) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
        'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        'permissions-policy': 'camera=(), microphone=(), geolocation=()', 'x-request-id': requestId,
        ...(config.development ? {} : { 'strict-transport-security': 'max-age=31536000' }), ...headers });
      res.end(Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body));
    };
    let authenticatedOwner;
    try {
      ensure(++requests <= 64, 503, 'capacity', 'Service is busy.');
      store.purge(); checkOrigin(req, config);
      ensure(typeof req.url === 'string' && req.url.startsWith('/') && !req.url.startsWith('//') && req.url.length <= 2048, 400, 'url', 'Invalid request URL.');
      const url = new URL(req.url, config.origin), route = url.pathname;
      limit(req.socket.remoteAddress || 'unknown'); // Proxy headers are intentionally not trusted for identity or limits.
      if (req.method === 'GET' && staticFiles.has(route) && !url.search) {
        const [file, type] = staticFiles.get(route); return send(200, await readFile(new URL('./public/' + file, import.meta.url)), { 'content-type': type + '; charset=utf-8' });
      }
      if (req.method === 'GET' && route === '/healthz') return send(200, { status: 'ok', release: 'connected-beta', publicLaunchReady: false });
      if (req.method === 'POST' && route === '/webhooks/github') {
        const raw = await bodyBytes(req, 1_000_000);
        ensure(verifyWebhook(raw, req.headers['x-hub-signature-256'], config.webhookSecret), 401, 'webhook_signature', 'Invalid webhook signature.');
        let payload; try { payload = JSON.parse(raw); } catch { throw new HttpError(400, 'webhook_body', 'Invalid webhook JSON.'); }
        const event = req.headers['x-github-event'];
        if (event === 'github_app_authorization' && payload.action === 'revoked' && Number.isSafeInteger(payload.sender?.id)) {
          const owner = String(payload.sender.id); service.abortOwner(owner); store.invalidate(owner);
        } else if (['installation', 'installation_repositories'].includes(event)) {
          // Conservative invalidation also covers deleted/suspended installations and removed repositories.
          for (const a of service.active.values()) a.controller.abort(); store.invalidateAll();
        }
        return send(200, { received: true });
      }
      if (req.method === 'GET' && route === '/auth/github') {
        ensure(!req.headers.origin || req.headers.origin === config.origin, 403, 'origin', 'Start sign-in from Graft.');
        loginLimit(req.socket.remoteAddress || 'unknown');
        const state = opaque(), verifier = opaque();
        store.put('oauth', sha256(state), '', { verifier }, store.now() + 600_000);
        const params = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.origin + '/auth/callback', state,
          code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
        return send(302, '', { location: 'https://github.com/login/oauth/authorize?' + params, 'set-cookie': cookie(config, 'oauth', state, 600) });
      }
      if (req.method === 'GET' && route === '/auth/callback') {
        const state = url.searchParams.get('state'), code = url.searchParams.get('code');
        ensure(url.searchParams.getAll('state').length === 1 && identity(state) && equal(state, readCookie(req, cookieName(config, 'oauth'))), 403, 'oauth_state', 'Sign-in state mismatch. Start sign-in again.');
        const attempt = store.consume('oauth', sha256(state)); ensure(attempt, 403, 'oauth_state', 'Sign-in expired or was already used.');
        ensure(url.searchParams.getAll('code').length === 1 && typeof code === 'string' && /^[A-Za-z0-9_-]{1,512}$/.test(code) && !url.searchParams.has('error'), 400, 'oauth_code', 'GitHub authorization was not completed.');
        const token = await github.exchange(code, attempt.verifier, abort.signal), user = await github.user(token.token, abort.signal);
        ensure(config.allowedUsers.has(String(user.id)), 403, 'invite_required', 'This beta is invite-only.');
        const old = readCookie(req, cookieName(config, 'session')); if (old) store.remove('session', sha256(old));
        const session = store.session(user, token.token, token.expiresIn, config);
        return send(303, '', { location: '/', 'set-cookie': [cookie(config, 'oauth', '', 0), cookie(config, 'session', session.sid, Math.floor((session.expires - store.now()) / 1000))] });
      }
      const sid = readCookie(req, cookieName(config, 'session')), sessionKey = sid ? sha256(sid) : '';
      const session = sid ? store.get('session', sessionKey) : null;
      ensure(session && config.allowedUsers.has(session.owner), 401, 'session', 'Sign in to continue.');
      authenticatedOwner = session.owner;
      if (!['GET', 'HEAD'].includes(req.method)) {
        checkOrigin(req, config, true); ensure(equal(req.headers['x-csrf-token'], session.csrf), 403, 'csrf', 'Refresh the page before this action.');
      }
      if (req.method === 'GET' && route === '/api/session') return send(200, { user: session.user, csrf: session.csrf,
        aiConfigured: Boolean(config.providerKey && config.model), writesEnabled: config.writesEnabled,
        verificationAvailable: false, retentionHours: 24, userDailyDraftLimit: config.userDailyLimit });
      if (req.method === 'POST' && route === '/api/logout') {
        service.abortOwner(session.owner); store.remove('session', sessionKey);
        return send(200, { signedOut: true }, { 'set-cookie': cookie(config, 'session', '', 0) });
      }
      if (req.method === 'POST' && route === '/api/account/delete') {
        service.abortOwner(session.owner); store.deleteOwner(session.owner);
        return send(200, { deleted: true, note: 'GitHub branches/PRs and provider-side retention are not deleted by this action.' }, { 'set-cookie': cookie(config, 'session', '', 0) });
      }
      if (req.method === 'GET' && route === '/api/repos') return send(200, { repositories: await github.repositories(session.token, abort.signal) });
      if (req.method === 'GET' && route === '/api/jobs') return send(200, { jobs: store.jobs(session.owner).map(j => service.view(j, false)) });
      if (req.method === 'POST' && route === '/api/jobs') return send(202, service.view(service.start(sessionKey, session, await jsonBody(req))));
      const match = route.match(/^\/api\/jobs\/([A-Za-z0-9_-]{43})(?:\/(cancel|publish))?$/);
      if (match) {
        const [, id, action] = match;
        if (req.method === 'GET' && !action) return send(200, service.view(service.owned(session.owner, id)));
        if (req.method === 'POST' && action === 'cancel') return send(200, service.view(service.cancel(session.owner, id)));
        if (req.method === 'POST' && action === 'publish') return send(200, await service.publish(sessionKey, session, id, await jsonBody(req)));
      }
      throw new HttpError(404, 'not_found', 'Not found.');
    } catch (e) {
      if (e.code === 'github_auth' && authenticatedOwner) { service.abortOwner(authenticatedOwner); store.invalidate(authenticatedOwner); }
      // Never return provider text, tokens, code, cookies, URLs with OAuth codes, or raw stack traces.
      send(e instanceof HttpError ? e.status : 502, { error: e instanceof HttpError ? e.message : 'Request failed. No automatic retry was performed.', code: e instanceof HttpError ? e.code : 'request_failed', requestId });
    } finally { requests--; clearTimeout(timer); }
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 5_000;
  return { server, store, service, async close() { await service.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); store.close(); } };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  const config = readConfig(), app = createConnectedApp({ config });
  const port = Number(process.env.PORT || 4319);
  ensure(Number.isInteger(port) && port >= 1024 && port <= 65535, 500, 'configuration', 'Invalid PORT.');
  app.server.listen(port, process.env.GRAFT_LISTEN_HOST || '127.0.0.1', () => console.log('Graft connected beta is listening. Public launch gates remain open.'));
  const cleanup = setInterval(() => app.store.purge(), 60_000); cleanup.unref();
  let closing = false;
  const close = async () => { if (closing) return; closing = true; clearInterval(cleanup); await app.close(); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
}
