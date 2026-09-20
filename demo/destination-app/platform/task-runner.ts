export interface ProgressUpdate {
  progress: number;
  stage: 'queued' | 'extracting' | 'indexing' | 'complete';
}

export async function runProcessingJob(_fileId: string): Promise<ProgressUpdate[]> {
  return [
    { progress: 0, stage: 'queued' },
    { progress: 50, stage: 'extracting' },
    { progress: 90, stage: 'indexing' },
    { progress: 100, stage: 'complete' },
  ];
}
