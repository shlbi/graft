export interface StoredUpload {
  id: string;
  name: string;
  content: string;
}

const objects = new Map<string, StoredUpload>();
let sequence = 0;

export async function storeUpload(name: string, content: string): Promise<StoredUpload> {
  const upload = { id: `blob-${++sequence}`, name, content };
  objects.set(upload.id, upload);
  return upload;
}

export async function readUpload(id: string): Promise<StoredUpload> {
  const upload = objects.get(id);
  if (!upload) throw new Error(`stored upload not found: ${id}`);
  return upload;
}
