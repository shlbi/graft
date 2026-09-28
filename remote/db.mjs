import pg from 'pg';
import {env} from './env.mjs';
const {Pool}=pg;
let pool;
export function db(){
  if(!pool)pool=new Pool({connectionString:env('DATABASE_URL'),max:5,idleTimeoutMillis:10000,connectionTimeoutMillis:5000,ssl:process.env.NODE_ENV==='production'?{rejectUnauthorized:true}:undefined});
  return pool;
}
export async function withTx(fn){const client=await db().connect();try{await client.query('BEGIN');const value=await fn(client);await client.query('COMMIT');return value;}catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}}
