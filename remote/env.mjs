export function env(name,{optional=false}={}){
  const value=process.env[name];
  if(!value&&!optional)throw new Error(`Missing required environment variable: ${name}`);
  return value||'';
}
export const resource=()=>process.env.REPOT_MCP_RESOURCE||'https://mcp.getrepot.com/mcp';
export function intEnv(name,fallback,min,max){const raw=process.env[name];if(!raw)return fallback;const n=Number(raw);if(!Number.isInteger(n)||n<min||n>max)throw new Error(`${name} must be an integer from ${min} to ${max}`);return n;}
