import { runSourceDemo } from './app.js';

void runSourceDemo().then(result => {
  console.log(JSON.stringify({ app: 'source', feature: 'upload-processing-progress', result }, null, 2));
});
