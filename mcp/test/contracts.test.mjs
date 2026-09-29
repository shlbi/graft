/**
 * @file MCP production/local contract regression module that guards Repot authorization, storage, and publication invariants.
 *
 * Evidence invariant: only record checks that actually executed; never promote a skipped or simulated result to verified.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const server=await readFile(new URL('../server.mjs',import.meta.url),'utf8');
const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
test('MCP uses official v2 server SDK and stdio entry point',()=>{assert.equal(pkg.dependencies['@modelcontextprotocol/server'],'2.1.0');assert.ok(server.includes("from '@modelcontextprotocol/server'"));assert.ok(server.includes("from '@modelcontextprotocol/server/stdio'"));assert.ok(server.includes('serveStdio(buildServer)'));});
test('tools expose inspect, draft, and gated apply with correct annotations',()=>{for(const name of ['repot_inspect','repot_draft','repot_apply'])assert.ok(server.includes(`registerTool('${name}'`));assert.match(server,/repot_inspect[\s\S]*?readOnlyHint:true/);assert.match(server,/repot_apply[\s\S]*?readOnlyHint:false[\s\S]*?destructiveHint:true/);assert.ok(server.includes('if(!options.writes)'));});
test('MCP documents verification as not run and never shells out',()=>{assert.ok(server.includes("build:'not_run',tests:'not_run',integration:'not_run'"));assert.doesNotMatch(server,/child_process|exec\(|spawn\(|shell:/);});
test('server includes safety resource and move-feature prompt',()=>{assert.ok(server.includes("registerResource('repot-safety'"));assert.ok(server.includes("registerPrompt('move-feature'"));});
