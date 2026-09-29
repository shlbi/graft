/**
 * @file Local stdio Repot MCP development module (config.mjs). The hosted remote MCP is the production product; this code remains a reference and local fallback.
 *
 * Safety note: local repository access must remain confined to explicit roots, and writes stay opt-in.
 */
/**
 * @function parseArgs
 * Implements parse args for the local MCP workflow.
 * Safety: preserve allowed-root confinement, stale-review checks, and the default read-only posture.
 */
export function parseArgs(argv=process.argv.slice(2),env=process.env){
  const roots=[];let writes=env.REPOT_MCP_ALLOW_WRITES==='1';
  for(let i=0;i<argv.length;i++){
    if(argv[i]==='--allow-root'){if(!argv[i+1])throw new Error('--allow-root requires a directory');roots.push(argv[++i]);}
    else if(argv[i]==='--allow-writes')writes=true;
    else if(argv[i]==='--read-only')writes=false;
    else throw new Error(`Unknown Repot MCP option: ${argv[i]}`);
  }
  return{roots,writes,apiKey:env.OPENAI_API_KEY||'',model:env.REPOT_AI_MODEL||env.GRAFT_AI_MODEL||''};
}
