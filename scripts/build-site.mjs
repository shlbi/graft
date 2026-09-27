// Static Repot frontend only. Never copy backend source, secrets, SQLite or test fixtures.
import { copyFile, mkdir, readdir, rm, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
export async function buildSite(root = fileURLToPath(new URL('../', import.meta.url))) {
  const output = resolve(root, '.repot-site');
  const existing = await lstat(output).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (existing?.isSymbolicLink()) throw new Error('Refusing to replace a symlinked site output.');
  await rm(output, { recursive: true, force: true }); await mkdir(output);
  for (const name of ['index.html', 'style.css', 'app.mjs']) await copyFile(resolve(root, 'web/connected/public', name), resolve(output, name));
  const files = await readdir(output); console.log(`Repot frontend built: ${files.join(', ')} → .repot-site/`);
  return output;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildSite();
