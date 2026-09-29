/**
 * @file Synthetic Repot demo source/support module (demo/source-app/features/upload/types.ts) used by repeatable transfer and verification examples.
 *
 * Demo invariant: do not confuse fixture behavior with production guarantees.
 */
import type { ProgressUpdate } from '../../adapters/jobs.js';

export interface UploadResult {
  fileId: string;
  name: string;
  progress: ProgressUpdate[];
}
