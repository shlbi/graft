/**
 * @file MCP production/local contract regression module that guards Repot authorization, storage, and publication invariants.
 *
 * Evidence invariant: only record checks that actually executed; never promote a skipped or simulated result to verified.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewStore } from '../review-store.mjs';
test('reviews expire and consume exactly once',()=>{let now=1000;const store=new ReviewStore({ttlMs:50,now:()=>now});const id=store.put({x:1});assert.deepEqual(store.get(id),{x:1});assert.deepEqual(store.consume(id),{x:1});assert.equal(store.get(id),null);const id2=store.put({x:2});now=1051;assert.equal(store.get(id2),null);});
