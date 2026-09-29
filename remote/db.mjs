/**
 * @file PostgreSQL pool and transaction helpers shared by production server-side modules.
 *
 * Production invariant: never log secrets, repository file bodies, OAuth tokens, or GitHub access tokens from this module.
 */
import pg from 'pg';
import {env} from './env.mjs';
const {Pool}=pg;
let pool;
/**
 * @function db
 * Implements db for this production module; preserve its documented security and side-effect contract.
 * Security: keep least-privilege authorization, bounded inputs, and explicit failure handling intact.
 */
export function db(){
  if(!pool)pool=new Pool({connectionString:env('DATABASE_URL'),max:5,idleTimeoutMillis:10000,connectionTimeoutMillis:5000,ssl:process.env.NODE_ENV==='production'?{rejectUnauthorized:true}:undefined});
  return pool;
}
/**
 * @function withTx
 * Performs with tx; this path may mutate durable state and must remain failure-aware and idempotent where documented.
 * Security: keep least-privilege authorization, bounded inputs, and explicit failure handling intact.
 */
export async function withTx(fn){const client=await db().connect();try{await client.query('BEGIN');const value=await fn(client);await client.query('COMMIT');return value;}catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}}
