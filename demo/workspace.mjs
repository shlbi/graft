import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';

function safeRelativePath(value) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\') || value.includes(':')) {
    throw new Error(`unsafe snapshot path: ${String(value)}`);
  }
  const normalized = posix.normalize(value);
  if (normalized !== value || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error(`unsafe snapshot path: ${value}`);
  }
  return normalized;
}

async function writeSnapshots(root, snapshots) {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const seen = new Set();
  for (const snapshot of snapshots) {
    const path = safeRelativePath(snapshot.path);
    if (seen.has(path)) throw new Error(`duplicate snapshot path: ${path}`);
    seen.add(path);
    const target = join(root, ...path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, snapshot.content, 'utf8');
  }
}

export async function createDemoWorkspace(baselineSnapshots) {
  const parent = await mkdtemp(join(tmpdir(), 'graft-demo-'));
  const root = join(parent, 'destination');
  const baseline = baselineSnapshots.map(snapshot => ({ ...snapshot }));
  await writeSnapshots(root, baseline);

  let closed = false;
  const assertOpen = () => {
    if (closed) throw new Error('demo workspace is closed');
  };

  return {
    root,
    async apply(resultSnapshots) {
      assertOpen();
      await writeSnapshots(root, resultSnapshots);
    },
    async reset() {
      assertOpen();
      await writeSnapshots(root, baseline);
    },
    async read(path) {
      assertOpen();
      const safe = safeRelativePath(path);
      return readFile(join(root, ...safe.split('/')), 'utf8');
    },
    async close() {
      if (closed) return;
      closed = true;
      await rm(parent, { recursive: true, force: true });
    },
  };
}
