/**
 * @file Synthetic Repot demo source/support module (demo/source-app/entry.ts) used by repeatable transfer and verification examples.
 *
 * Demo invariant: do not confuse fixture behavior with production guarantees.
 */
import { runSourceDemo } from './app.js';

void runSourceDemo().then(result => {
  console.log(JSON.stringify({ app: 'source', feature: 'upload-processing-progress', result }, null, 2));
});
