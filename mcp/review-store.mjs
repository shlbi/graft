/**
 * @file Local stdio Repot MCP development module (review-store.mjs). The hosted remote MCP is the production product; this code remains a reference and local fallback.
 *
 * Safety note: local repository access must remain confined to explicit roots, and writes stay opt-in.
 */
import { randomBytes } from 'node:crypto';
export class ReviewStore {
  constructor({ttlMs=30*60*1000,now=Date.now}={}){this.ttlMs=ttlMs;this.now=now;this.items=new Map();}
  put(value){this.purge();const id=randomBytes(18).toString('base64url');this.items.set(id,{value,expires:this.now()+this.ttlMs});return id;}
  get(id){this.purge();const item=this.items.get(id);return item?.value??null;}
  consume(id){const value=this.get(id);if(value)this.items.delete(id);return value;}
  purge(){const t=this.now();for(const[id,item]of this.items)if(item.expires<=t)this.items.delete(id);}
}
