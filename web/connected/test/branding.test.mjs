import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PUBLIC_ASSETS, staticFiles } from '../public-assets.mjs';
import { buildSite } from '../../../scripts/build-site.mjs';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const assets = join(root, 'web/connected/public');
const html = await readFile(join(assets, 'index.html'), 'utf8');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const gitBlob = bytes => createHash('sha1').update(`blob ${Buffer.byteLength(bytes)}\0`).update(bytes).digest('hex');

test('header and footer replace R with the uploaded mark, without a duplicate emblem or letter', () => {
  const marks = [...html.matchAll(/<a class="wordmark"[^>]*>([\s\S]*?)<\/a>/g)];
  assert.equal(marks.length, 2);
  for (const m of marks) {
    assert.match(m[0], /aria-label="Repot home"/);
    assert.equal([...m[1].matchAll(/<img\b/g)].length, 1);
    assert.match(m[1], /class="wordmark-logo"[^>]*alt="" aria-hidden="true"/);
    assert.match(m[1], /class="wordmark-text" aria-hidden="true">epot<\/span>/);
    assert.doesNotMatch(m[1], /Repot|brand-mark|wordmark-dot/);
  }
});

test('tab icons have declared sizes, real PNG dimensions and preserved alpha channels', async () => {
  const links = [...html.matchAll(/<link rel="icon" type="image\/png" sizes="(\d+)x\1" href="([^"?]+)">/g)];
  assert.deepEqual(links.map(m => Number(m[1])), [32, 64]);
  for (const [, side, route] of links) {
    const [file, type] = staticFiles.get(route);
    assert.equal(type, 'image/png');
    const b = await readFile(join(assets, file));
    assert.equal(b.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(b.readUInt32BE(16), Number(side));
    assert.equal(b.readUInt32BE(20), Number(side));
    assert.equal(b[25], 3); // Indexed PNG with an explicit transparency table.
    assert.ok(b.includes(Buffer.from('tRNS')));
  }
});

test('resized brand assets are the reviewed derivatives of the supplied logo', async () => {
  assert.equal(sha(await readFile(join(assets, 'assets/repot-mark-c7217cca.png'))), '882a49920478b297e4941ffb914b45f7445c3fdf183ff01878e04e772f148bdd');
  assert.equal(sha(await readFile(join(assets, 'assets/repot-favicon-c7217cca.png'))), '61ae3cf9314915bc3e95165a9c921db6fea36a5a70bd0faaf6d98173596160a6');
});

test('wordmark layout inherits the existing palette and does not mask or recolor the uploaded logo', async () => {
  const css = await readFile(join(assets, 'brand.css'), 'utf8');
  assert.match(css, /object-fit:\s*contain/);
  assert.doesNotMatch(css, /filter:|clip-path:|mask:|background:|#[0-9a-f]{3,8}|url\(/i);
  assert.ok(html.indexOf('href="/brand.css"') > html.indexOf('href="/style.css"'));
});

test('all brand URLs are on the shared public allowlist, not remote providers or arbitrary directories', () => {
  for (const m of html.matchAll(/(?:src|href)="(\/[^"#?]+)"/g)) assert.ok(staticFiles.has(m[1]), m[1]);
  assert.equal(new Set(PUBLIC_ASSETS.map(a => a.route)).size, PUBLIC_ASSETS.length);
  assert.equal(new Set(PUBLIC_ASSETS.map(a => a.file)).size, PUBLIC_ASSETS.length);
  for (const path of ['/assets/.env', '/assets/private-key.pem', '/server.mjs', '/assets/../store.mjs']) assert.equal(staticFiles.has(path), false);
});

test('all non-branding HTML is byte-for-byte preserved from the checked remote base', () => {
  const newMark = '<a class="wordmark" href="#top" aria-label="Repot home"><img class="wordmark-logo" src="/assets/repot-mark-c7217cca.png" width="64" height="64" alt="" aria-hidden="true"><span class="wordmark-text" aria-hidden="true">epot</span></a>';
  let restored = html.replace(newMark, '<a class="wordmark" href="#top" aria-label="Repot home"><span class="brand-mark" aria-hidden="true"></span>Repot<span class="wordmark-dot" aria-hidden="true">↗</span></a>');
  restored = restored.replace(newMark, '<a class="wordmark" href="#top"><span class="brand-mark" aria-hidden="true"></span>Repot</a>');
  restored = restored.replace(/^  <link rel="icon"[^\n]+\n/gm, '').replace('  <link rel="stylesheet" href="/brand.css">\n', '');
  assert.equal(gitBlob(restored), '7633401096d69b0ae2ee1619e5ecb56355459cfe');
});

test('server changes only the public asset map and MIME handling, preserving authentication and job code', async () => {
  const source = await readFile(join(root, 'web/connected/server.mjs'), 'utf8');
  assert.ok(source.indexOf('staticFiles.has(route)') < source.indexOf("store.get('session'"));
  const restored = source.replace("import { staticFiles } from './public-assets.mjs';", "const staticFiles = new Map([['/', ['index.html', 'text/html']], ['/app.mjs', ['app.mjs', 'text/javascript']], ['/style.css', ['style.css', 'text/css']]]);")
    .replace("{ 'content-type': type }", "{ 'content-type': type + '; charset=utf-8' }");
  assert.equal(gitBlob(restored), 'a98417a3c08f95fcca4dbb80ba57d7547acdd53e');
});

test('build copies the exact allowlisted assets and omits nested secrets (explicit build fixture)', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'repot-brand-build-'));
  try {
    const publicDir = join(scratch, 'web/connected/public'), expected = new Map();
    for (const { file } of PUBLIC_ASSETS) {
      // The existing app/CSS are unchanged; these two fixture files test copying, not application behavior.
      const bytes = ['style.css', 'app.mjs'].includes(file) ? Buffer.from(`/* build fixture: ${file} */\n`) : await readFile(join(assets, file));
      expected.set(file, bytes); await mkdir(dirname(join(publicDir, file)), { recursive: true }); await writeFile(join(publicDir, file), bytes);
    }
    for (const name of ['.env', 'connected.sqlite', 'assets/private-key.pem']) await writeFile(join(publicDir, name), 'DO_NOT_COPY');
    const output = await buildSite(scratch);
    assert.deepEqual((await readdir(output, { recursive: true })).filter(x => x !== 'assets').sort(), [...expected.keys()].sort());
    for (const [file, bytes] of expected) assert.deepEqual(await readFile(join(output, file)), bytes);
    await writeFile(join(output, 'stale.txt'), 'stale'); await buildSite(scratch);
    await assert.rejects(readFile(join(output, 'stale.txt')), { code: 'ENOENT' });
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test('brand asset build still refuses a symlinked output directory', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'repot-brand-link-'));
  try {
    await mkdir(join(scratch, 'keep')); await writeFile(join(scratch, 'keep', 'data'), 'preserved');
    await symlink(join(scratch, 'keep'), join(scratch, '.repot-site'), 'dir');
    await assert.rejects(buildSite(scratch), /symlink/);
    assert.equal(await readFile(join(scratch, 'keep', 'data'), 'utf8'), 'preserved');
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
