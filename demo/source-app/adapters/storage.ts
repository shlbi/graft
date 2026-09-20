export interface StoredUpload {
  id: string;
  name: string;
  content: string;
}

const uploads = new Map<string, StoredUpload>();
let sequence = 0;

export async function storeUpload(name: string, content: string): Promise<StoredUpload> {
  const upload = { id: `upload-${++sequence}`, name, content };
  uploads.set(upload.id, upload);
  return upload;
}

export function readUpload(id: string): StoredUpload | undefined {
  return uploads.get(id);
}
