/**
 * @file Demo fixture/support module (demo/destination-app/entry.ts). It exists to exercise Repot behavior against synthetic code rather than customer repositories.
 *
 * Demo invariant: keep examples deterministic and clearly separate illustrative behavior from production claims.
 */
import { runDestinationBaseline } from './app.js';

const baseline = runDestinationBaseline();
let output: unknown = baseline;
// graft:mount:upload-processing-progress
console.log(JSON.stringify(output, null, 2));
