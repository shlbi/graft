/**
 * @file Synthetic Repot demo source/support module (demo/source-app/adapters/jobs.ts) used by repeatable transfer and verification examples.
 *
 * Demo invariant: do not confuse fixture behavior with production guarantees.
 */
export interface ProgressUpdate {
  progress: number;
  stage: 'queued' | 'extracting' | 'indexing' | 'complete';
}

/**
 * @function runProcessingJob
 * Implements run processing job for this synthetic demo.
 */
export async function runProcessingJob(_fileId: string): Promise<ProgressUpdate[]> {
  const updates: ProgressUpdate[] = [
    { progress: 0, stage: 'queued' },
    { progress: 35, stage: 'extracting' },
    { progress: 75, stage: 'indexing' },
    { progress: 100, stage: 'complete' },
  ];
  for (const _update of updates) await Promise.resolve();
  return updates;
}
