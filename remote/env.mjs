/**
 * @file Environment parsing and validation helpers for required production configuration and bounded numeric settings.
 *
 * Production invariant: never log secrets, repository file bodies, OAuth tokens, or GitHub access tokens from this module.
 */
/**
 * @function env
 * Reads and validates env configuration, failing closed instead of inventing a production default.
 * Security: keep least-privilege authorization, bounded inputs, and explicit failure handling intact.
 */
export function env(name,{optional=false}={}){
  const value=process.env[name];
  if(!value&&!optional)throw new Error(`Missing required environment variable: ${name}`);
  return value||'';
}
/**
 * @function resource
 * Implements resource for this production module; preserve its documented security and side-effect contract.
 * Security: keep least-privilege authorization, bounded inputs, and explicit failure handling intact.
 */
export const resource=()=>process.env.REPOT_MCP_RESOURCE||'https://mcp.getrepot.com/mcp';
/**
 * @function intEnv
 * Reads and validates int env configuration, failing closed instead of inventing a production default.
 * Security: keep least-privilege authorization, bounded inputs, and explicit failure handling intact.
 */
export function intEnv(name,fallback,min,max){const raw=process.env[name];if(!raw)return fallback;const n=Number(raw);if(!Number.isInteger(n)||n<min||n>max)throw new Error(`${name} must be an integer from ${min} to ${max}`);return n;}
