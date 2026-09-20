import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const testDirectory = join(root, 'test');
const files = readdirSync(testDirectory).filter(name => name.endsWith('.test.mjs')).sort().map(name => join(testDirectory, name));
if (!files.length) throw new Error('No test files discovered');
const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: root, stdio: 'inherit', shell: false, windowsHide: true, timeout: 180_000,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
