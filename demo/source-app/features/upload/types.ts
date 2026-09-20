import type { ProgressUpdate } from '../../adapters/jobs.js';

export interface UploadResult {
  fileId: string;
  name: string;
  progress: ProgressUpdate[];
}
