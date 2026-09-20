import { runProcessingJob } from '../../adapters/jobs.js';
import { storeUpload } from '../../adapters/storage.js';
import type { UploadResult } from './types.js';

export async function uploadAndProcess(name: string, content: string): Promise<UploadResult> {
  const stored = await storeUpload(name, content);
  const progress = await runProcessingJob(stored.id);
  return { fileId: stored.id, name: stored.name, progress };
}
