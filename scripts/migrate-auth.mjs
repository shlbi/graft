import {getMigrations} from 'better-auth/db/migration';
import {getAuth} from '../remote/auth.mjs';
const {toBeCreated,toBeAdded,runMigrations}=await getMigrations(getAuth().options);
console.log(`Better Auth migration: ${toBeCreated.length} table(s) create, ${toBeAdded.length} field(s) add`);
await runMigrations();
console.log('Better Auth migration complete');
