/**
 * @file Runs Repot's exact Better Auth schema migration from the pinned production auth configuration.
 *
 * Temporary deployment note: the production build invokes this script so Vercel can use the DATABASE_URL
 * already stored in its environment. Preview deployments skip schema writes. Once production reports a
 * clean migration/build, remove this script from the build command and keep it as an operator-only command.
 */
import {getMigrations} from 'better-auth/db/migration';
import {getAuth} from '../remote/auth.mjs';
import {db} from '../remote/db.mjs';

/**
 * @function migrateAuth
 * Compares the live PostgreSQL schema with Repot's configured Better Auth 1.7.6 + JWT + MCP/CIMD schema
 * and applies only the missing tables/columns/indexes through Better Auth's supported migration engine.
 *
 * Safety: Vercel preview builds never mutate production schema. The migration is idempotent and uses the
 * same auth configuration the runtime uses, avoiding hand-maintained OAuth table definitions.
 */
async function migrateAuth(){
  if(process.env.VERCEL==='1' && process.env.VERCEL_ENV!=='production'){
    console.log('Better Auth migration skipped outside Vercel production.');
    return;
  }
  const {toBeCreated,toBeAdded,runMigrations}=await getMigrations(getAuth().options);
  console.log(`Better Auth migration plan: ${toBeCreated.length} table(s) create, ${toBeAdded.length} field(s) add`);
  if(toBeCreated.length||toBeAdded.length){
    await runMigrations();
    console.log('Better Auth migration applied.');
  }else{
    console.log('Better Auth schema already current; no changes applied.');
  }
}

try{
  await migrateAuth();
}finally{
  await db().end().catch(()=>{});
}
