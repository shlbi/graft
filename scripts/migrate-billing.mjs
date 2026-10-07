/** Explicit operator command only. Does not create products, charge cards or enable billing. */
import {readFile} from 'node:fs/promises';
if (process.argv.slice(2).join(' ') !== '--execute') {
  console.error('Usage: node scripts/migrate-billing.mjs --execute'); process.exitCode = 1;
} else {
  const {db} = await import('../remote/db.mjs');
  const pool = db();
  try {
    await pool.query(await readFile(new URL('../docs/migrations/002-billing.sql', import.meta.url),'utf8'));
    console.log('Billing schema applied. Billing activation is a separate operator step.');
  } catch { console.error('Billing migration failed. Inspect database setup without sharing credentials.'); process.exitCode = 1; }
  finally { await pool.end(); }
}
