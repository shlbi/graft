/**
 * @file Durable encrypted review storage, expiry cleanup, publication claiming, idempotency state, and per-user usage accounting.
 *
 * Production invariant: never log secrets, repository file bodies, OAuth tokens, or GitHub access tokens from this module.
 */
import {randomBytes} from 'node:crypto';
import {db,withTx} from './db.mjs';
import {seal,open} from './crypto.mjs';
import {intEnv} from './env.mjs';
/**
 * @function ttl
 * Implements ttl for this production module; preserve its documented security and side-effect contract.
 * Security: keep least-privilege authorization, bounded inputs, and explicit failure handling intact.
 */
const ttl=()=>intEnv('REPOT_REVIEW_TTL_MINUTES',60,10,1440);
/**
 * @function saveReview
 * Performs save review; this path may mutate durable state and must remain failure-aware and idempotent where documented.
 * Security: keep least-privilege authorization, bounded inputs, and explicit failure handling intact.
 */
export async function saveReview({userId,sourceRepo,destinationRepo,destinationRevision,review}){
  const id=randomBytes(24).toString('base64url'),expires=new Date(Date.now()+ttl()*60000);
  await db().query('INSERT INTO repot_review(id,user_id,source_repo,destination_repo,destination_revision,payload,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,userId,sourceRepo,destinationRepo,destinationRevision,seal(review),expires]);
  return{id,expiresAt:expires.toISOString()};
}
/**
 * @function getReview
 * Retrieves get review data while enforcing the module's authorization and validation boundaries.
 * Security: keep least-privilege authorization, bounded inputs, and explicit failure handling intact.
 */
export async function getReview(userId,id){
  const {rows}=await db().query('SELECT * FROM repot_review WHERE id=$1 AND user_id=$2',[id,userId]);
  const row=rows[0];if(!row)return null;if(new Date(row.expires_at).getTime()<=Date.now())return{...row,expired:true};
  return{...row,review:open(row.payload),expired:false};
}
/**
 * @function publishStoredReview
 * Performs publish stored review; this path may mutate durable state and must remain failure-aware and idempotent where documented.
 * Security: keep least-privilege authorization, bounded inputs, and explicit failure handling intact.
 */
export async function publishStoredReview(userId,id,fn){
  const claimed=await withTx(async client=>{
    const {rows}=await client.query('SELECT * FROM repot_review WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,userId]);
    const row=rows[0];if(!row)throw new Error('Review not found');if(new Date(row.expires_at).getTime()<=Date.now())throw new Error('Review expired');
    if(row.status==='published')return{already:true,url:row.published_url,branch:row.branch_name};
    if(row.status==='publishing')throw new Error('This review is already being published. Retry shortly.');
    if(row.status!=='ready')throw new Error('Review is not publishable');
    await client.query("UPDATE repot_review SET status='publishing' WHERE id=$1",[id]);
    return{row:{...row,review:open(row.payload)}};
  });
  if(claimed.already)return claimed;
  try{
    const result=await fn(claimed.row);
    await db().query("UPDATE repot_review SET status='published',published_url=$2,branch_name=$3 WHERE id=$1 AND user_id=$4",[id,result.url,result.branch,userId]);
    return result;
  }catch(error){
    await db().query("UPDATE repot_review SET status='ready' WHERE id=$1 AND user_id=$2 AND status='publishing'",[id,userId]).catch(()=>{});
    throw error;
  }
}
/**
 * @function incrementUsage
 * Performs increment usage; this path may mutate durable state and must remain failure-aware and idempotent where documented.
 * Security: keep least-privilege authorization, bounded inputs, and explicit failure handling intact.
 */
export async function incrementUsage(userId,kind){
  const column=kind==='drafts'?'drafts':'publishes',limit=intEnv(kind==='drafts'?'REPOT_DAILY_DRAFT_LIMIT':'REPOT_DAILY_PUBLISH_LIMIT',kind==='drafts'?20:10,1,1000);
  return withTx(async client=>{await client.query('INSERT INTO repot_usage(user_id,usage_day) VALUES($1,CURRENT_DATE) ON CONFLICT DO NOTHING',[userId]);const {rows}=await client.query(`SELECT ${column} AS value FROM repot_usage WHERE user_id=$1 AND usage_day=CURRENT_DATE FOR UPDATE`,[userId]);if(rows[0].value>=limit)throw new Error(`Daily Repot ${kind} limit reached`);await client.query(`UPDATE repot_usage SET ${column}=${column}+1 WHERE user_id=$1 AND usage_day=CURRENT_DATE`,[userId]);return{used:rows[0].value+1,limit};});
}
/**
 * @function cleanupExpired
 * Performs cleanup expired; this path may mutate durable state and must remain failure-aware and idempotent where documented.
 * Security: keep least-privilege authorization, bounded inputs, and explicit failure handling intact.
 */
export async function cleanupExpired(){await db().query("DELETE FROM repot_review WHERE expires_at < now() - interval '1 day'");}
