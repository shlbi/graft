// Static Repot frontend only. Never copy backend source, secrets, SQLite or test fixtures.
import { copyFile, mkdir, readdir, rm, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { PUBLIC_ASSETS } from '../web/connected/public-assets.mjs';
export async function buildSite(root = fileURLToPath(new URL('../', import.meta.url))) {
  const output = resolve(root, '.repot-site');
  const existing = await lstat(output).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (existing?.isSymbolicLink()) throw new Error('Refusing to replace a symlinked site output.');
  await rm(output, { recursive: true, force: true }); await mkdir(output);
  for (const { file } of PUBLIC_ASSETS) {
    const target = resolve(output, file);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(resolve(root, 'web/connected/public', file), target);
  }
  const files = await readdir(output); console.log(`Repot frontend built: ${files.join(', ')} → .repot-site/`);
  return output;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildSite();
