/**
 * @file Synthetic Repot demo source/support module (demo/source-app/adapters/storage.ts) used by repeatable transfer and verification examples.
 *
 * Demo invariant: do not confuse fixture behavior with production guarantees.
 */
export interface StoredUpload {
  id: string;
  name: string;
  content: string;
}

const uploads = new Map<string, StoredUpload>();
let sequence = 0;

/**
 * @function storeUpload
 * Implements store upload for this synthetic demo.
 */
export async function storeUpload(name: string, content: string): Promise<StoredUpload> {
  const upload = { id: `upload-${++sequence}`, name, content };
  uploads.set(upload.id, upload);
  return upload;
}

/**
 * @function readUpload
 * Implements read upload for this synthetic demo.
 */
export function readUpload(id: string): StoredUpload | undefined {
  return uploads.get(id);
}
