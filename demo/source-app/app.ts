/**
 * @file Synthetic Repot demo source/support module (demo/source-app/app.ts) used by repeatable transfer and verification examples.
 *
 * Demo invariant: do not confuse fixture behavior with production guarantees.
 */
import { uploadAndProcess } from './features/upload/service.js';

/**
 * @function runSourceDemo
 * Implements run source demo for this synthetic demo.
 */
export async function runSourceDemo() {
  return uploadAndProcess('quarterly-notes.txt', 'Graft source demo payload');
}
