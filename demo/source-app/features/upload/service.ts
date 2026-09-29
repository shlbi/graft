/**
 * @file Synthetic Repot demo source/support module (demo/source-app/features/upload/service.ts) used by repeatable transfer and verification examples.
 *
 * Demo invariant: do not confuse fixture behavior with production guarantees.
 */
import { runProcessingJob } from '../../adapters/jobs.js';
import { storeUpload } from '../../adapters/storage.js';
import type { UploadResult } from './types.js';

/**
 * @function uploadAndProcess
 * Implements upload and process for this synthetic demo.
 */
export async function uploadAndProcess(name: string, content: string): Promise<UploadResult> {
  const stored = await storeUpload(name, content);
  const progress = await runProcessingJob(stored.id);
  return { fileId: stored.id, name: stored.name, progress };
}
