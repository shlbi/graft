import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSite } from '../../../scripts/build-site.mjs';
import { PUBLIC_ASSETS } from '../public-assets.mjs';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const assets = join(root,'web/connected/public');
const html = await readFile(join(assets,'index.html'),'utf8'), css = await readFile(join(assets,'style.css'),'utf8');
test('Repot is the visible brand and release limits are not hidden',()=>{assert.match(html,/<title>Repot/);assert.doesNotMatch(html.replace(/<[^>]*>/g,''),/\bGraft\b|®|trusted by|guaranteed/i);assert.match(html,/Public production acceptance is incomplete/);assert.match(html,/ILLUSTRATION/);});
test('every internal navigation anchor resolves; IDs are unique',()=>{const ids=[...html.matchAll(/id="([^"]+)"/g)].map(m=>m[1]);assert.equal(new Set(ids).size,ids.length);for(const m of html.matchAll(/href="#([^"]+)"/g))assert.ok(ids.includes(m[1]),m[1]);});
test('all inputs have explicit labels; consent and review remain separate',()=>{for(const id of ['source','destination','feature'])assert.match(html,new RegExp(`for="${id}"`));for(const id of ['consent','acknowledge','workflows'])assert.match(html,new RegExp(`<label class="checkbox"><input id="${id}"`));assert.match(html,/id="composer" disabled/);});
test('palette is limited to obsidian and bone with opacity, not accent colors',()=>{const hex=new Set([...css.matchAll(/#[0-9a-f]{3,8}\b/ig)].map(m=>m[0].toUpperCase()));assert.deepEqual([...hex].sort(),['#0D0D0F','#E7E1D8']);for(const m of css.matchAll(/rgb\(([^)]+)\)/g))assert.equal(m[1].split('/')[0].trim(),'231 225 216');});
test('reduced motion, keyboard focus and mobile layouts are present',()=>{assert.match(css,/prefers-reduced-motion:reduce/);assert.match(css,/:focus-visible/);assert.match(css,/max-width:760px/);assert.match(css,/max-width:380px/);assert.match(html,/class="skip"/);assert.match(html,/aria-live="polite"/);});
test('no externally hosted fonts, executable inline handlers or tracking dependencies',()=>{assert.doesNotMatch(html,/<script[^>]+src="https?:|<link[^>]+href="https?:|\son(?:click|load|error)=/);assert.doesNotMatch(css,/@import|url\(https?:/);assert.match(html,/<script type="module" src="\/app.mjs">/);});
test('static build exports exact allowlisted bytes and never exports secrets/backend', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'repot-site-test-'));
  try {
    const publicDir = join(scratch, 'web/connected/public');
    for (const { file } of PUBLIC_ASSETS) {
      await mkdir(dirname(join(publicDir, file)), { recursive: true });
      await writeFile(join(publicDir, file), await readFile(join(assets, file)));
    }
    for (const file of ['.env', 'connected.sqlite', 'assets/private-key.pem'])
      await writeFile(join(publicDir, file), 'DO_NOT_EXPORT');
    const output = await buildSite(scratch);
    const actual = (await readdir(output, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name).slice(output.length + 1).replaceAll('\\\\', '/')).sort();
    assert.deepEqual(actual, PUBLIC_ASSETS.map(a => a.file).sort());
    for (const { file } of PUBLIC_ASSETS)
      assert.deepEqual(await readFile(join(output, file)), await readFile(join(assets, file)));
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
test('build refuses a symlink output rather than deleting an arbitrary destination',async()=>{const scratch=await mkdtemp(join(tmpdir(),'repot-site-link-'));try{await mkdir(join(scratch,'keep'));await writeFile(join(scratch,'keep','important'),'preserved');await symlink(join(scratch,'keep'),join(scratch,'.repot-site'),'dir');await assert.rejects(buildSite(scratch),/symlink/);assert.equal(await readFile(join(scratch,'keep','important'),'utf8'),'preserved');}finally{await rm(scratch,{recursive:true,force:true});}});
test('Vercel uses the Next.js production runtime rather than the old static-only deployment',async()=>{const config=JSON.parse(await readFile(join(root,'vercel.json'),'utf8'));assert.equal(config.framework,'nextjs');assert.equal(config.outputDirectory,'.next');const next=await readFile(join(root,'next.config.mjs'),'utf8');assert.match(next,/Content-Security-Policy/);});

test('directional arrows explicitly request text presentation instead of emoji glyphs',async()=>{for(const file of ['index.html','app.mjs','mcp/index.html']){const source=await readFile(join(assets,file),'utf8');for(const arrow of ['↗','↘','↙','↖','↓','↑','→','←']){for(let i=source.indexOf(arrow);i>=0;i=source.indexOf(arrow,i+1))assert.equal(source.codePointAt(i+arrow.length),0xFE0E,\`${file}: bare ${arrow} can render as emoji on iOS\`);}}});
