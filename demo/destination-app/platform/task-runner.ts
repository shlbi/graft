import { readUpload } from './blob-store.js';

export interface ProcessingMetrics {
  bytes: number;
  lines: number;
  words: number;
  uniqueWords: number;
  checksum: string;
}

export interface ProgressUpdate {
  progress: number;
  stage: 'queued' | 'extracting' | 'indexing' | 'complete';
  metrics?: ProcessingMetrics;
}

function checksum(content: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(content)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export async function runProcessingJob(fileId: string): Promise<ProgressUpdate[]> {
  const updates: ProgressUpdate[] = [{ progress: 0, stage: 'queued' }];
  await Promise.resolve();

  const upload = await readUpload(fileId);
  const bytes = new TextEncoder().encode(upload.content).length;
  const lines = upload.content.length === 0 ? 0 : upload.content.split(/\r?\n/u).length;
  updates.push({ progress: 50, stage: 'extracting' });
  await Promise.resolve();

  const tokens = upload.content.match(/[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)*/gu) ?? [];
  const uniqueWords = new Set(tokens.map(token => token.toLocaleLowerCase('en-US'))).size;
  updates.push({ progress: 90, stage: 'indexing' });
  await Promise.resolve();

  updates.push({
    progress: 100,
    stage: 'complete',
    metrics: { bytes, lines, words: tokens.length, uniqueWords, checksum: checksum(upload.content) },
  });
  return updates;
}
