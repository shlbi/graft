/**
 * @file Authenticated-encryption helpers that protect durable Repot review payloads at rest.
 *
 * Production invariant: never log secrets, repository file bodies, OAuth tokens, or GitHub access tokens from this module.
 */
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {env} from './env.mjs';
/**
 * @function key
 * Implements key for this production module; preserve its documented security and side-effect contract.
 * Security: keep least-privilege authorization, bounded inputs, and explicit failure handling intact.
 */
function key(){const raw=Buffer.from(env('REPOT_DATA_KEY'),'base64');if(raw.length!==32)throw new Error('REPOT_DATA_KEY must decode to exactly 32 bytes');return raw;}
/**
 * @function seal
 * Encrypts and authenticates Repot review data using the configured application data key.
 * Security: keep least-privilege authorization, bounded inputs, and explicit failure handling intact.
 */
export function seal(value){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(),iv);const body=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]),tag=cipher.getAuthTag();return ['v1',iv.toString('base64url'),tag.toString('base64url'),body.toString('base64url')].join('.');}
/**
 * @function open
 * Authenticates and decrypts Repot review data using the configured application data key.
 * Security: keep least-privilege authorization, bounded inputs, and explicit failure handling intact.
 */
export function open(token){const [version,iv,tag,body,...extra]=String(token).split('.');if(version!=='v1'||extra.length)throw new Error('Unsupported encrypted review payload');const decipher=createDecipheriv('aes-256-gcm',key(),Buffer.from(iv,'base64url'));decipher.setAuthTag(Buffer.from(tag,'base64url'));return JSON.parse(Buffer.concat([decipher.update(Buffer.from(body,'base64url')),decipher.final()]).toString('utf8'));}
