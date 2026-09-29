/**
 * @file Repository automation script for build.mjs used by Repot's build, evidence, migration, or validation workflow.
 *
 * Operator note: this script is tooling, not a request handler; failures should stop the workflow rather than be silently ignored.
 */
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
rmSync(new URL('../dist/', import.meta.url), { recursive: true, force: true });
execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.engine.json'], {
  cwd: root, stdio: 'inherit', shell: false, windowsHide: true, timeout: 60_000,
});
