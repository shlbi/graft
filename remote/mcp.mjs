/**
 * @file Production Repot MCP tool surface for repository discovery, inspection, AI drafting, review, and explicit publication.
 *
 * Production invariant: never log secrets, repository file bodies, OAuth tokens, or GitHub access tokens from this module.
 */
import {createMcpHandler,McpServer} from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import {analyze} from '../web/lib/core.mjs';
import {proposeWithAI,REPOT_AI_MODEL} from '../web/lib/ai.mjs';
import {Fault} from '../web/lib/core-base.mjs';
import {githubTokenForUser,listRepositories,snapshotRepository,publishDraft} from './github.mjs';
import {saveReview,getReview,publishStoredReview,incrementUsage,cleanupExpired} from './reviews.mjs';
import {env} from './env.mjs';
import {createDraftExecution,DRAFT_AI_TIMEOUT_MS} from './draft-execution.mjs';

const transfer=z.object({
  sourceRepo:z.string().min(3).max(140).describe('Source GitHub repository as owner/repo'),
  destinationRepo:z.string().min(3).max(140).describe('Destination GitHub repository as owner/repo'),
  feature:z.string().min(3).max(1500).describe('Feature behavior to move and destination constraints')
});
/**
 * @function ok
 * Implements ok for this production module; preserve its documented security and side-effect contract.
 * Security: keep least-privilege authorization, bounded inputs, and explicit failure handling intact.
 */
const ok=value=>({content:[{type:'text',text:JSON.stringify(value,null,2)}]});
/**
 * @function fail
 * Implements fail for this production module; preserve its documented security and side-effect contract.
 * Security: keep least-privilege authorization, bounded inputs, and explicit failure handling intact.
 */
const fail=error=>({content:[{type:'text',text:error instanceof Fault?error.message:(error?.message||'Repot failed without changing a repository.')}],isError:true});
/**
 * @function userId
 * Implements user id for this production module; preserve its documented security and side-effect contract.
 * Security: keep least-privilege authorization, bounded inputs, and explicit failure handling intact.
 */
const userId=authInfo=>{const id=authInfo?.extra?.userId;if(typeof id!=='string'||!id)throw new Fault('Repot could not resolve the authenticated user.',401);return id;};

/**
 * @function createRepotServer
 * Constructs create repot server for downstream callers without weakening configured security defaults.
 * Security: keep least-privilege authorization, bounded inputs, and explicit failure handling intact.
 */
export function createRepotServer(authInfo,requestSignal){
  const server=new McpServer({name:'repot',version:'0.2.0',description:'Move reviewed features and related tests between GitHub repositories.'});
  server.registerTool('repot_repositories',{
    title:'List Repot repositories',
    description:'List GitHub repositories currently available to the authenticated Repot GitHub App user. Read-only.',
    inputSchema:z.object({}),
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true}
  },async()=>{try{const token=await githubTokenForUser(userId(authInfo));return ok({repositories:await listRepositories(token)});}catch(e){return fail(e);}});

  server.registerTool('repot_inspect',{
    title:'Inspect feature transfer',
    description:'Read the source and destination default branches and discover candidate implementation, related tests/support, destination context, and risks. No AI call and no repository write.',
    inputSchema:transfer,
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true}
  },async args=>{try{
    if(args.sourceRepo.toLowerCase()===args.destinationRepo.toLowerCase())throw new Fault('Choose two different repositories.');
    const token=await githubTokenForUser(userId(authInfo));
    const [source,destination]=await Promise.all([snapshotRepository(token,args.sourceRepo),snapshotRepository(token,args.destinationRepo)]);
    const analysis=analyze(source.snapshot,destination.snapshot,args.feature),{context,...publicAnalysis}=analysis;
    return ok({...publicAnalysis,sourceRepository:source.meta,destinationRepository:destination.meta});
  }catch(e){return fail(e);}});

  server.registerTool('repot_draft',{
    title:'Draft feature transfer',
    description:'Create a bounded AI-assisted transfer from the authenticated user’s GitHub repositories. Selected repository code is sent to Repot’s configured OpenAI model. Uses GPT-6.1 Sol to return an encrypted durable review ID and exact patch; does not write GitHub or execute generated code. May take up to 240 seconds. Do not automatically retry failed drafts or bypass the review step.',
    inputSchema:transfer.extend({allowAI:z.literal(true).describe('Explicitly confirm selected code may be sent to Repot’s configured OpenAI model for this draft')}),
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:false,openWorldHint:true}
  },async (args,context)=>{
    const execution=createDraftExecution(context,requestSignal);
    try{
      // Validate consent, identity and configuration before spending an allowance.
      const uid=userId(authInfo);
      if(args.allowAI!==true)throw new Fault('Explicit code-sharing consent is required.',403);
      if(args.sourceRepo.toLowerCase()===args.destinationRepo.toLowerCase())throw new Fault('Choose two different repositories.');
      const apiKey=env('OPENAI_API_KEY');
      const token=await execution.run('github_access',()=>githubTokenForUser(uid));
      const [source,destination]=await execution.run('reading',signal=>Promise.all([
        snapshotRepository(token,args.sourceRepo,{signal}),
        snapshotRepository(token,args.destinationRepo,{signal})
      ]));
      const analysis=await execution.run('analyzing',()=>analyze(source.snapshot,destination.snapshot,args.feature));
      await execution.run('quota',async signal=>{
        await cleanupExpired().catch(()=>{});
        signal.throwIfAborted();
        return incrementUsage(uid,'drafts');
      });
      const review=await execution.run('generating',signal=>proposeWithAI({
        source:source.snapshot,destination:destination.snapshot,context:analysis.context,
        consent:true,apiKey,signal,timeoutMs:DRAFT_AI_TIMEOUT_MS
      }));
      const stored=await execution.run('saving',()=>saveReview({userId:uid,sourceRepo:source.meta.name,destinationRepo:destination.meta.name,destinationRevision:destination.snapshot.revision,review}));
      return ok({reviewId:stored.id,expiresAt:stored.expiresAt,model:REPOT_AI_MODEL,summary:review.summary,exportable:review.exportable,changes:review.changes.map(c=>({path:c.path,action:c.action,reason:c.reason,sourcePaths:c.sourcePaths})),testTransfer:review.testTransfer,risks:review.risks,suggestedChecks:review.suggestedChecks,verification:review.verification,patch:review.patch,notice:review.notice});
    }catch(error){
      const code=execution.timedOut?'draft_timeout':execution.cancelled?'draft_cancelled':error?.code==='ai_timeout'?'ai_timeout':'draft_failed';
      const message=code==='draft_timeout'?'The draft reached its 240-second application deadline.':code==='draft_cancelled'?'The requesting client cancelled or disconnected.':error instanceof Fault?error.message:'Repot could not finish this draft. Check server configuration and service availability.';
      // Never reflect raw database/provider errors, credentials, or abort reasons.
      return {...ok({error:{code,stage:execution.stage,message},retryAutomatically:false,
        notice:'No repository files were changed. Do not publish or bypass review without a successful review ID. A timed-out database save may still finish; no successful draft is claimed.'}),isError:true};
    }finally{execution.dispose();}
  });

  server.registerTool('repot_review',{
    title:'Read stored Repot review',
    description:'Retrieve an unexpired review created by this authenticated user before publishing it. Read-only.',
    inputSchema:z.object({reviewId:z.string().min(20)}),
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}
  },async({reviewId})=>{try{const row=await getReview(userId(authInfo),reviewId);if(!row||row.expired)throw new Fault('Review not found or expired.',404);return ok({reviewId,status:row.status,sourceRepo:row.source_repo,destinationRepo:row.destination_repo,summary:row.review.summary,changes:row.review.changes.map(c=>({path:c.path,action:c.action,reason:c.reason})),testTransfer:row.review.testTransfer,risks:row.review.risks,verification:row.review.verification,patch:row.review.patch,publishedUrl:row.published_url});}catch(e){return fail(e);}});

  server.registerTool('repot_publish',{
    title:'Publish reviewed transfer as draft PR',
    description:'Create a new repot/* branch and GitHub draft pull request from an exact stored review. Never writes the default branch and never merges. Refuses stale destinations. Use only after the user has reviewed the exact Repot review.',
    inputSchema:z.object({reviewId:z.string().min(20),confirmReviewed:z.literal(true).describe('Confirm the user reviewed this exact Repot review and wants a draft PR')}),
    annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:true}
  },async({reviewId})=>{try{
    const uid=userId(authInfo);
    const token=await githubTokenForUser(uid);
    const existing=await getReview(uid,reviewId);
    if(existing?.status!=='published')await incrementUsage(uid,'publishes');
    const result=await publishStoredReview(uid,reviewId,row=>publishDraft(token,{reviewId,destinationRepo:row.destination_repo,destinationRevision:row.destination_revision,review:row.review}));
    return ok(result.already?{alreadyPublished:true,url:result.url,branch:result.branch}:{draftPullRequest:true,url:result.url,branch:result.branch,number:result.number,verification:{build:'not_run',tests:'not_run',integration:'not_run'},notice:'Repot created a draft PR only. It did not merge or execute generated code. Run project checks before merging.'});
  }catch(e){return fail(e);}});

  server.registerResource('repot-safety','repot://safety',{title:'Repot production safety contract',mimeType:'text/markdown'},async uri=>({contents:[{uri:uri.href,mimeType:'text/markdown',text:'# Repot safety\n\nRepot reads only repositories authorized through the user’s GitHub App connection. AI drafting requires explicit allowAI=true. Reviews are encrypted at rest and expire. Publication creates a new branch and draft pull request only; Repot never auto-merges. Generated code is never executed by the MCP service, so build/tests/integration remain not_run until an isolated verifier runs them.'}]}));
  return server;
}

export const mcpHandler=createMcpHandler(({authInfo,requestInfo})=>createRepotServer(authInfo,requestInfo?.signal),{legacy:'stateless',maxRequestBodySize:1_000_000});
