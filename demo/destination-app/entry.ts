import { runDestinationBaseline } from './app.js';

const baseline = runDestinationBaseline();
let output: unknown = baseline;
// graft:mount:upload-processing-progress
console.log(JSON.stringify(output, null, 2));
