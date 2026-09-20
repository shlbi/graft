import { uploadAndProcess } from './features/upload/service.js';

export async function runSourceDemo() {
  return uploadAndProcess('quarterly-notes.txt', 'Graft source demo payload');
}
