/**
 * @file Explicit operator migration for resumable draft storage. Never run from a deploy build or cold start.
 * Use only after reviewing/approving the additive SQL against the intended branch/database.
 */
import {readFile} from 'node:fs/promises';
import {db} from '../remote/db.mjs';

/** Apply the reviewed SQL atomically and always release the connection and pool. */
async function migrateDraftJobs() {
  const sql = await readFile(new URL('../docs/migrations/001-draft-jobs.sql',import.meta.url),'utf8');
  const pool = db(), client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query(sql);
    await client.query('COMMIT');
    console.log('Repot draft-job schema is present. No existing auth or review rows were changed.');
  } catch(error) {await client.query('ROLLBACK').catch(()=>{});throw error;}
  finally {client.release();await pool.end();}
}
await migrateDraftJobs();
