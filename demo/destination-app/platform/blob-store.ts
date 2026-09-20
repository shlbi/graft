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
