/**
 * @file Execute the real AI request/parser module and structural validator offline.
 * Only core.mjs's test-transplant layer is replaced; that layer is unchanged by
 * this work and its runtime is not claimed verified by these focused tests.
 */
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import * as base from '../../web/lib/core-base.mjs';
import * as contract from '../../web/lib/proposal-contract.mjs';
import * as policy from '../../web/lib/policy.mjs';

/** Load unmodified module bytes with a closed, explicit dependency map and no network. */
export async function loadTestAI() {
  const context = vm.createContext({ URL, Headers, Request, Response, Buffer, AbortSignal, AbortController, DOMException,
    setTimeout, clearTimeout, fetch: () => { throw new Error('Unexpected network'); } });
  const dependencies = {
    './core.mjs': { ...base, reviewProposal(...args) { return { ...base.reviewProposal(...args), exportable: true, testTransfer: { status: 'synthetic_not_executed' } }; } },
    './proposal-contract.mjs': contract, './policy.mjs': policy, './github.mjs': { boundedJSON() { throw new Error('Unexpected foreground provider read'); } }
  };
  const module = new vm.SourceTextModule(await readFile(new URL('../../web/lib/ai.mjs', import.meta.url), 'utf8'), { context });
  await module.link(specifier => {
    assert.ok(Object.hasOwn(dependencies, specifier));
    const exports = dependencies[specifier];
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate(); return module.namespace;
}
