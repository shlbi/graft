import {randomBytes} from 'node:crypto';
import {db,withTx} from './db.mjs';
import {seal,open} from './crypto.mjs';
import {intEnv} from './env.mjs';
const ttl=()=>intEnv('REPOT_REVIEW_TTL_MINUTES',60,10,1440);
export async function saveReview({userId,sourceRepo,destinationRepo,destinationRevision,review}){
  const id=randomBytes(24).toString('base64url'),expires=new Date(Date.now()+ttl()*60000);
  await db().query('INSERT INTO repot_review(id,user_id,source_repo,destination_repo,destination_revision,payload,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,userId,sourceRepo,destinationRepo,destinationRevision,seal(review),expires]);
  return{id,expiresAt:expires.toISOString()};
}
export async function getReview(userId,id,{forUpdate=false,client=null}={}){
  const q=client||db(),suffix=forUpdate?' FOR UPDATE':'';
  const {rows}=await q.query(`SELECT * FROM repot_review WHERE id=$1 AND user_id=$2${suffix}`,[id,userId]);
  const row=rows[0];if(!row)return null;if(new Date(row.expires_at).getTime()<=Date.now())return{...row,expired:true};
  return{...row,review:open(row.payload),expired:false};
}
export async function consumeForPublish(userId,id,fn){return withTx(async client=>{const row=await getReview(userId,id,{forUpdate:true,client});if(!row)throw new Error('Review not found');if(row.expired)throw new Error('Review expired');if(row.status==='published')return{already:true,url:row.published_url,branch:row.branch_name};if(row.status!=='ready')throw new Error('Review is not publishable');await client.query("UPDATE repot_review SET status='publishing' WHERE id=$1",[id]);try{const result=await fn(row);await client.query("UPDATE repot_review SET status='published',published_url=$2,branch_name=$3 WHERE id=$1",[id,result.url,result.branch]);return result;}catch(error){await client.query("UPDATE repot_review SET status='ready' WHERE id=$1",[id]);throw error;}});}
export async function incrementUsage(userId,kind){
  const column=kind==='drafts'?'drafts':'publishes',limit=intEnv(kind==='drafts'?'REPOT_DAILY_DRAFT_LIMIT':'REPOT_DAILY_PUBLISH_LIMIT',kind==='drafts'?20:10,1,1000);
  return withTx(async client=>{await client.query('INSERT INTO repot_usage(user_id,usage_day) VALUES($1,CURRENT_DATE) ON CONFLICT DO NOTHING',[userId]);const {rows}=await client.query(`SELECT ${column} AS value FROM repot_usage WHERE user_id=$1 AND usage_day=CURRENT_DATE FOR UPDATE`,[userId]);if(rows[0].value>=limit)throw new Error(`Daily Repot ${kind} limit reached`);await client.query(`UPDATE repot_usage SET ${column}=${column}+1 WHERE user_id=$1 AND usage_day=CURRENT_DATE`,[userId]);return{used:rows[0].value+1,limit};});
}
export async function cleanupExpired(){await db().query("DELETE FROM repot_review WHERE expires_at < now() - interval '1 day'");}
