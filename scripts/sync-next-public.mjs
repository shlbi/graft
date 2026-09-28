import {copyFile,mkdir,rm} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {PUBLIC_ASSETS} from '../web/connected/public-assets.mjs';
const root=resolve(import.meta.dirname,'..'),out=resolve(root,'public');
await rm(out,{recursive:true,force:true});await mkdir(out,{recursive:true});
for(const {file} of PUBLIC_ASSETS){const to=resolve(out,file);await mkdir(dirname(to),{recursive:true});await copyFile(resolve(root,'web/connected/public',file),to);}
console.log('Repot public assets synced for Next.js');
