/**
 * @file Connected-web regression/fixture module (web/connected/test/mcp-page.test.mjs) covering Repot authentication, delivery, presentation, or storage contracts.
 *
 * Test invariant: simulated GitHub/AI/browser behavior must be labeled as simulated and must not be reported as live acceptance.
 */
import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
const html=await readFile(new URL('../public/mcp/index.html',import.meta.url),'utf8'),css=await readFile(new URL('../public/mcp/mcp.css',import.meta.url),'utf8');
test('MCP page is the remote one-link experience',()=>{assert.match(html,/https:\/\/mcp\.getrepot\.com\/mcp/);assert.match(html,/Copy MCP URL/);assert.match(html,/STREAMABLE HTTP/);assert.match(html,/OAUTH 2\.1/);assert.doesNotMatch(html,/git clone|npm install|--allow-root|LOCAL STDIO ALPHA/);});
test('MCP page explains review and draft-PR safety boundaries',()=>{for(const text of ['default branch is never written','encrypted at rest','not_run','ILLUSTRATIVE FLOW · NOT A RUN RESULT'])assert.ok(html.includes(text));});
test('MCP page keeps the two-color system and mobile layout',()=>{assert.doesNotMatch(css,/#(?:[0-9a-f]{3}){1,2}\b|rgb\(/i);assert.ok(css.includes('@media(max-width:900px)'));assert.ok(css.includes('@media(max-width:600px)'));});
