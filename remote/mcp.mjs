/**
 * @file Repot's authenticated remote MCP tools. Drafts use durable short steps, not a long foreground call.
 * A job ID is not a review ID. Only a validated, exportable review can be explicitly published.
 */
import {createMcpHandler,McpServer} from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import {analyze} from '../web/lib/core.mjs';
import {Fault} from '../web/lib/core-base.mjs';
import {githubTokenForUser,listRepositories,snapshotRepository,publishDraft} from './github.mjs';
import {getReview,publishStoredReview,incrementUsage} from './reviews.mjs';
import {draftService} from './draft-service.mjs';
import {publicJobError} from './draft-job-errors.mjs';

const transfer=z.object({
  sourceRepo:z.string().min(3).max(140).describe('Source GitHub repository as owner/repo'),
  destinationRepo:z.string().min(3).max(140).describe('Destination GitHub repository as owner/repo'),
  feature:z.string().min(3).max(1500).describe('Feature behavior to move and destination constraints')
});
const jobInput=z.object({jobId:z.string().regex(/^[A-Za-z0-9_-]{32}$/).describe('Opaque jobId returned by repot_draft; not a provider response ID')});
/** Return structured text without inventing verification. */
const ok=value=>({content:[{type:'text',text:JSON.stringify(value,null,2)}]});
/** Preserve public policy errors while suppressing private database/provider exceptions. */
const fail=error=>({content:[{type:'text',text:error instanceof Fault?error.message:'Repot could not complete this operation. No success is claimed.'}],isError:true});
/** Obtain identity only from the verified MCP authorization context. */
const userId=authInfo=>{const id=authInfo?.extra?.userId;if(typeof id!=='string'||!id)throw new Fault('Repot could not resolve the authenticated user.',401);return id;};

/** Register all tools with explicit side effects and retain the existing authenticated GitHub access boundary. */
export function createRepotServer(authInfo,requestSignal){
  const server=new McpServer({name:'repot',version:'0.3.0',description:'Move reviewed features and related tests between GitHub repositories. Drafts return durable jobs; poll the same job instead of reducing the requested feature.'});
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
    title:'Start resumable feature draft',
    description:'Persist a draft job and return jobId immediately, before generation. Resume it with repot_draft_status until a reviewId is ready. Reuse requestKey if the initial response is lost; never switch features or start a new generation automatically. Uses GPT-6.1 Sol. Background generation temporarily stores response data at OpenAI for polling (roughly 10 minutes even with store:false); explicit background consent is required. No GitHub writes or generated-code execution.',
    inputSchema:transfer.extend({
      allowAI:z.literal(true).describe('Explicitly confirm selected code may be sent to Repot’s configured OpenAI model for this draft'),
      allowBackgroundProcessing:z.literal(true).describe('User permits asynchronous processing and temporary provider-side response storage for polling; this is not zero retention'),
      requestKey:z.string().regex(/^[A-Za-z0-9_-]{8,80}$/).describe('Choose once for this transfer, e.g. focusflow-pomodoro-001. Reuse exactly this value after a transport error; a different key can incur another generation charge')
    }),
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}
  },async args=>{
    try{return ok(await draftService().start(userId(authInfo),args));}
    catch(error){return {...ok(publicJobError(error)),isError:true};}
  });

  server.registerTool('repot_draft_status',{
    title:'Resume or check a draft job',
    description:'Perform one bounded step of the SAME durable job: prepare pinned repositories, submit one background AI request, or poll/finalize its result. Returns quickly with status and nextTool; follow pollAfterSeconds. This can charge the draft allowance once when submitting, but polling never regenerates or republishes. Do not change the feature to work around pending status. A completed job returns a reviewId; call repot_review before explicit repot_publish.',
    inputSchema:jobInput,
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true}
  },async({jobId})=>{
    try{const result=await draftService().status(userId(authInfo),jobId);return {...ok(result),...(result.status==='failed'?{isError:true}:{})};}
    catch(error){return {...ok(publicJobError(error)),isError:true};}
  });

  server.registerTool('repot_draft_cancel',{
    title:'Cancel a draft job',
    description:'Persist cancellation for an owned draft job. A leased step observes it before review finalization. Best-effort cancel/delete the provider response; report pending cleanup instead of pretending it succeeded. Does not undo a review already completed, create another generation, or change GitHub.',
    inputSchema:jobInput,
    annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:true}
  },async({jobId})=>{
    try{return ok(await draftService().cancel(userId(authInfo),jobId));}
    catch(error){return {...ok(publicJobError(error)),isError:true};}
  });

  server.registerTool('repot_review',{
    title:'Read stored Repot review',
    description:'Retrieve an unexpired review owned by this user. Read the exact patch, exportable flag, risks and verification before publishing. A jobId cannot be published; use its completed reviewId.',
    inputSchema:z.object({reviewId:z.string().min(20)}),
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}
  },async({reviewId})=>{try{const row=await getReview(userId(authInfo),reviewId);if(!row||row.expired)throw new Fault('Review not found or expired.',404);return ok({reviewId,status:row.status,exportable:row.review.exportable,sourceRepo:row.source_repo,destinationRepo:row.destination_repo,summary:row.review.summary,changes:row.review.changes.map(c=>({path:c.path,action:c.action,reason:c.reason})),testTransfer:row.review.testTransfer,risks:row.review.risks,suggestedChecks:row.review.suggestedChecks,verification:row.review.verification,patch:row.review.patch,publishedUrl:row.published_url});}catch(e){return fail(e);}});

  server.registerTool('repot_publish',{
    title:'Publish reviewed transfer as draft PR',
    description:'Create a new repot/* branch and draft pull request from an exact exportable review. Never writes the default branch and never merges. Refuses stale destinations. Use only after the user reviewed this exact review, not a pending job.',
    inputSchema:z.object({reviewId:z.string().min(20),confirmReviewed:z.literal(true).describe('Confirm the user reviewed this exact Repot review and wants a draft PR')}),
    annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:true}
  },async({reviewId,confirmReviewed})=>{try{
    if(confirmReviewed!==true)throw new Fault('Review confirmation is required.',403);
    const uid=userId(authInfo);
    const existing=await getReview(uid,reviewId);
    if(!existing||existing.expired)throw new Fault('Review not found or expired.',404);
    if(existing.status!=='published'&&existing.review?.exportable!==true)throw new Fault('This review is not exportable. Publishing is blocked.',409);
    const token=await githubTokenForUser(uid);
    if(existing?.status!=='published')await incrementUsage(uid,'publishes');
    const result=await publishStoredReview(uid,reviewId,row=>publishDraft(token,{reviewId,destinationRepo:row.destination_repo,destinationRevision:row.destination_revision,review:row.review}));
    return ok(result.already?{alreadyPublished:true,url:result.url,branch:result.branch}:{draftPullRequest:true,url:result.url,branch:result.branch,number:result.number,verification:{build:'not_run',tests:'not_run',integration:'not_run'},notice:'Repot created a draft PR only. It did not merge or execute generated code. Run project checks before merging.'});
  }catch(e){return fail(e);}});

  server.registerResource('repot-safety','repot://safety',{title:'Repot safety contract',mimeType:'text/markdown'},async uri=>({contents:[{uri:uri.href,mimeType:'text/markdown',text:'# Repot safety\n\nGitHub access is user-authorized. Draft jobs are owner-bound and encrypted. Explicit AI/background consent is required; background mode temporarily stores response data at OpenAI for polling despite store:false. Poll the same job, do not submit duplicates or substitute features. A job is not a reviewed transfer. Only an exportable review can be explicitly published to a new branch and draft PR. No auto-merge or generated-code execution. Build/tests/integration remain not_run until independently executed.'}]}));
  return server;
}

export const mcpHandler=createMcpHandler(({authInfo,requestInfo})=>createRepotServer(authInfo,requestInfo?.signal),{legacy:'stateless',maxRequestBodySize:1_000_000});
