/** Local demo boundary only; not a replacement for production authentication. */
export function assertLoopbackHost(host) {
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('demo servers must bind to loopback');
}
export function isLocalRequest(request) {
  const port = request.socket.localPort;
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const authority = request.headers.host;
  const origin = request.headers.origin;
  return hosts.has(authority) && (!origin || origin === `http://${authority}`)
    && request.headers['sec-fetch-site'] !== 'cross-site';
}
export function decodeUploadText(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw Object.assign(new Error('upload must contain valid UTF-8 text'), { statusCode: 415 }); }
}
