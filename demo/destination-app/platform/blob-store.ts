/**
 * @file Demo fixture/support module (demo/destination-app/platform/blob-store.ts). It exists to exercise Repot behavior against synthetic code rather than customer repositories.
 *
 * Demo invariant: keep examples deterministic and clearly separate illustrative behavior from production claims.
 */
export interface StoredUpload {
  id: string;
  name: string;
  content: string;
}

const objects = new Map<string, StoredUpload>();
let sequence = 0;

/**
 * @function storeUpload
 * Implements store upload for the deterministic Repot demo fixture.
 */
export async function storeUpload(name: string, content: string): Promise<StoredUpload> {
  const upload = { id: `blob-${++sequence}`, name, content };
  objects.set(upload.id, upload);
  return upload;
}

/**
 * @function readUpload
 * Implements read upload for the deterministic Repot demo fixture.
 */
export async function readUpload(id: string): Promise<StoredUpload> {
  const upload = objects.get(id);
  if (!upload) throw new Error(`stored upload not found: ${id}`);
  return upload;
}
