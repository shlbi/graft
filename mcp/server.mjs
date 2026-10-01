/**
 * @file Local stdio Repot MCP development module (server.mjs). The hosted remote MCP is the production product; this code remains a reference and local fallback.
 *
 * Safety note: local repository access must remain confined to explicit roots, and writes stay opt-in.
 */
#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { analyze } from '../web/lib/core.mjs';
import { proposeWithAI } from '../web/lib/ai.mjs';
import { Fault } from '../web/lib/core-base.mjs';
import { normalizeRoots, snapshotLocalRepository, applyReviewedChanges } from './local-repo.mjs';
import { ReviewStore } from './review-store.mjs';
import { parseArgs } from './config.mjs';

const options=parseArgs();
const roots=await normalizeRoots(options.roots);
const reviews=new ReviewStore();

const transferInput=z.object({
  source:z.string().min(1).describe('Source repository directory inside an allowed root'),
  destination:z.string().min(1).describe('Destination repository directory inside an allowed root'),
  feature:z.string().min(3).max(1500).describe('Behavior to move and constraints that must remain unchanged')
});
/**
 * @function result
 * Implements result for the local MCP workflow.
 * Safety: preserve allowed-root confinement, stale-review checks, and the default read-only posture.
 */
const result=value=>({content:[{type:'text',text:typeof value==='string'?value:JSON.stringify(value,null,2)}]});
/**
 * @function failure
 * Implements failure for the local MCP workflow.
 * Safety: preserve allowed-root confinement, stale-review checks, and the default read-only posture.
 */
const failure=error=>({content:[{type:'text',text:error instanceof Fault?error.message:'Repot MCP failed without changing either repository.'}],isError:true});

/**
 * @function inspect
 * Implements inspect for the local MCP workflow.
 * Safety: preserve allowed-root confinement, stale-review checks, and the default read-only posture.
 */
async function inspect(args){
  const [source,destination]=await Promise.all([
    snapshotLocalRepository(args.source,roots),
    snapshotLocalRepository(args.destination,roots)
  ]);
  const analysis=analyze(source.snapshot,destination.snapshot,args.feature);
  const {context,...publicAnalysis}=analysis;
  return{source,destination,analysis,publicAnalysis};
}

/**
 * @function buildServer
 * Implements build server for the local MCP workflow.
 * Safety: preserve allowed-root confinement, stale-review checks, and the default read-only posture.
 */
function buildServer(){
  const server=new McpServer({
    name:'repot',
    version:'0.1.0',
    description:'Move a bounded feature and its related tests between local repositories with explicit review.'
  });

  server.registerTool('repot_inspect',{
    title:'Inspect feature transfer',
    description:'Read two allowed local repositories and discover candidate implementation files, related tests, support files, risks, and destination context. Makes no changes and does not call an AI provider.',
    inputSchema:transferInput,
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}
  },async args=>{
    try{
      const r=await inspect(args);
      return result({
        feature:r.publicAnalysis.feature,
        source:r.publicAnalysis.source,
        destination:r.publicAnalysis.destination,
        candidates:r.publicAnalysis.candidates,
        testPlan:r.publicAnalysis.testPlan,
        contextManifest:r.publicAnalysis.contextManifest,
        warnings:r.publicAnalysis.warnings
      });
    }catch(error){return failure(error);}
  });

  server.registerTool('repot_draft',{
    title:'Draft feature transfer',
    description:'Create a reviewable feature-transfer patch from two allowed local repositories. Requires OPENAI_API_KEY and defaults to GPT-6.1 Sol. The provider receives only Repot-selected bounded context. No files are changed and no generated code is executed.',
    inputSchema:transferInput,
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:false,openWorldHint:true}
  },async args=>{
    try{
      if(!options.apiKey) throw new Fault('AI drafting is disabled. Configure OPENAI_API_KEY in the MCP client environment.',503);
      const r=await inspect(args);
      const review=await proposeWithAI({
        source:r.source.snapshot,destination:r.destination.snapshot,context:r.analysis.context,
        consent:true,apiKey:options.apiKey,model:options.model
      });
      const reviewId=reviews.put({
        destinationRoot:r.destination.root,
        destinationFingerprint:r.destination.snapshot.fingerprint,
        review
      });
      return result({
        reviewId,
        expiresInMinutes:30,
        summary:review.summary,
        exportable:review.exportable,
        changes:review.changes.map(c=>({path:c.path,action:c.action,reason:c.reason,sourcePaths:c.sourcePaths})),
        testTransfer:review.testTransfer,
        risks:review.risks,
        suggestedChecks:review.suggestedChecks,
        verification:review.verification,
        patch:review.patch,
        notice:review.notice,
        writesEnabled:options.writes
      });
    }catch(error){return failure(error);}
  });

  server.registerTool('repot_apply',{
    title:'Apply reviewed transfer',
    description:'Write the exact files from a prior Repot review into its destination. This tool is unavailable unless the MCP operator starts Repot with --allow-writes or REPOT_MCP_ALLOW_WRITES=1. It refuses stale destinations, symlinks, deletes, and paths outside allowed roots. It never runs generated code or shell commands.',
    inputSchema:z.object({reviewId:z.string().min(10).describe('Review ID returned by repot_draft')}),
    annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:false}
  },async({reviewId})=>{
    try{
      if(!options.writes) throw new Fault('Repot MCP is read-only. Restart it with --allow-writes only when you want reviewed drafts to modify destination files.',403);
      const stored=reviews.get(reviewId);
      if(!stored) throw new Fault('Review is missing or expired. Draft again before applying.',404);
      const written=await applyReviewedChanges({
        destinationRoot:stored.destinationRoot,
        review:stored.review,
        expectedFingerprint:stored.destinationFingerprint,
        roots
      });
      reviews.consume(reviewId);
      return result({
        applied:true,
        files:written,
        verification:{build:'not_run',tests:'not_run',integration:'not_run'},
        notice:'Reviewed files were written. Repot did not run generated code, builds, tests, package managers, hooks, or shell commands. Review the diff and run checks in your normal isolated workflow before merging.'
      });
    }catch(error){return failure(error);}
  });

  server.registerResource('repot-safety','repot://safety',{
    title:'Repot MCP safety contract',mimeType:'text/markdown'
  },async uri=>({contents:[{uri:uri.href,mimeType:'text/markdown',text:
`# Repot MCP safety contract

- Reads only repositories inside operator-configured allowed roots.
- Ignores symlinks and common generated/secret directories.
- Bounded snapshots: ${750000} bytes, 1500 eligible text files, 60 KB per file.
- AI drafting is optional and requires an operator-provided API key/model.
- Drafting never executes generated code.
- Applying is disabled by default and writes only a stored reviewed change set.
- Apply refuses stale destination fingerprints, symlinks, deletes, and path escapes.
- Build/test/integration remain not_run until an external isolated verifier actually runs them.`}]}));

  server.registerPrompt('move-feature',{
    title:'Move a feature with Repot',
    description:'Guide an agent through inspect → draft → human review → optional apply.',
    argsSchema:z.object({
      source:z.string().describe('Source repository directory'),
      destination:z.string().describe('Destination repository directory'),
      feature:z.string().min(3).describe('Feature behavior to move')
    })
  },({source,destination,feature})=>({messages:[{role:'user',content:{type:'text',text:
`Use Repot to move this feature.

Source: ${source}
Destination: ${destination}
Feature: ${feature}

First call repot_inspect and explain the discovered implementation/tests and warnings. Then call repot_draft only if AI drafting is configured. Show me the proposed files, risks, test-transfer status, and verification status before any write. Do not call repot_apply unless I explicitly ask you to apply this exact reviewed draft.`}}]}));

  return server;
}

void serveStdio(buildServer);
console.error(`Repot MCP ready · ${roots.length} allowed root(s) · writes ${options.writes?'enabled':'disabled'}`);
