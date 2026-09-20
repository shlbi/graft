import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';

function safeRelativePath(value) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.endsWith('/')
    || /[\\:\x00-\x1f\x7f]/u.test(value)) {
    throw new Error(`unsafe snapshot path: ${String(value)}`);
  }
  const normalized = posix.normalize(value);
  if (normalized !== value || normalized === '.' || normalized.startsWith('../')) {
    throw new Error(`unsafe snapshot path: ${value}`);
  }
  return normalized;
}

/** Validate and detach the entire input before creating/removing any files. */
function validatedSnapshots(snapshots) {
  if (!Array.isArray(snapshots)) throw new Error('snapshots must be an array');
  const seen = new Set();
  const files = snapshots.map(snapshot => {
    const path = safeRelativePath(snapshot?.path);
    if (seen.has(path)) throw new Error(`duplicate snapshot path: ${path}`);
    if (typeof snapshot.content !== 'string') throw new Error(`invalid snapshot content: ${path}`);
    seen.add(path);
    return { path, content: snapshot.content };
  });
  for (const { path } of files) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/');
      if (seen.has(parent)) throw new Error(`file/directory snapshot collision: ${parent}`);
    }
  }
  return files;
}

/** Stage complete files before replacing this owned temporary workspace. */
async function replaceSnapshots(parent, root, snapshots) {
  const staging = await mkdtemp(join(parent, 'staging-'));
  const backup = join(parent, 'previous');
  try {
    for (const snapshot of snapshots) {
      const target = join(staging, ...snapshot.path.split('/'));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, snapshot.content, 'utf8');
    }
    await rename(root, backup);
    try {
      await rename(staging, root);
    } catch (error) {
      await rename(backup, root);
      throw error;
    }
    await rm(backup, { recursive: true, force: true });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Owned temporary fixture workspace, NOT a sandbox for arbitrary untrusted code
 * or a production filesystem transaction. Mutations/read/close are serialized.
 */
export async function createDemoWorkspace(baselineSnapshots) {
  const baseline = validatedSnapshots(baselineSnapshots);
  const parent = await mkdtemp(join(tmpdir(), 'graft-demo-'));
  const root = join(parent, 'destination');
  try {
    await mkdir(root);
    await replaceSnapshots(parent, root, baseline);
  } catch (error) {
    await rm(parent, { recursive: true, force: true });
    throw error;
  }

  let tail = Promise.resolve();
  let closing = false;
  let closePromise;
  function serialize(operation) {
    if (closing) return Promise.reject(new Error('demo workspace is closed'));
    const next = tail.then(operation);
    tail = next.catch(() => {});
    return next;
  }

  return {
    root,
    async apply(resultSnapshots) {
      const files = validatedSnapshots(resultSnapshots);
      return serialize(() => replaceSnapshots(parent, root, files));
    },
    async reset() {
      return serialize(() => replaceSnapshots(parent, root, baseline));
    },
    async read(path) {
      const safe = safeRelativePath(path);
      return serialize(() => readFile(join(root, ...safe.split('/')), 'utf8'));
    },
    async close() {
      if (!closePromise) {
        closing = true;
        closePromise = tail.then(() => rm(parent, { recursive: true, force: true }));
      }
      return closePromise;
    },
  };
}
