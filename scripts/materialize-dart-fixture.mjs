/**
 * @file Materialize an authored Dart/Flutter package transfer for independent SDK checks.
 * This uses the real Repot pipeline but an explicitly synthetic proposal, not a paid
 * generation or customer repository. It never runs a package manager/compiler or
 * overwrites an existing directory. Emitting files is not native runtime validation.
 */
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {analyze} from '../web/lib/core.mjs';
import {reviewFromAIResponse} from '../web/lib/ai.mjs';
import {dartFixture} from '../web/test/fixtures/dart-transfer-fixture.mjs';

/** Create a new fixture directory and preserve the original source/destination alongside the result. */
export async function materializeDartFixture(output,{flutter=false}={}) {
  if(typeof output!=='string'||!output.trim()||typeof flutter!=='boolean')throw new Error('Supply a new output directory and optional Flutter mode.');
  const target=path.resolve(output),f=dartFixture({flutter,collision:true});
  const a=analyze(f.source,f.destination,'cart pricing',f.context.selection);
  const response={status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(f.proposal)}]}]};
  const review=reviewFromAIResponse(response,{source:f.source,destination:f.destination,context:a.context});
  if(!review.exportable)throw new Error('Authored fixture did not produce an exportable structural review.');
  // Deliberately fail on EEXIST. Never merge a demo into somebody's working tree.
  await mkdir(target);
  /** Write a known fixture-relative path only inside the directory just created. */
  async function write(relative,content) {
    const filename=path.join(target,relative);
    if(!filename.startsWith(target+path.sep))throw new Error('Fixture path escaped its output directory.');
    await mkdir(path.dirname(filename),{recursive:true});await writeFile(filename,content,{flag:'wx'});
  }
  for(const file of f.source.files)await write('source/'+file.path,file.content);
  for(const file of f.destination.files)await write('destination-before/'+file.path,file.content);
  const after=new Map(f.destination.files.map(file=>[file.path,file.content]));
  for(const c of review.changes)after.set(c.path,c.content);
  for(const [p,content] of after)await write('destination-after/'+p,content);
  await write('transfer.patch',review.patch);
  const evidence={scope:'authored-package-fixture',proposal:'synthetic; no AI request',adapter:review.testTransfer.adapter,
    changedFiles:review.changes.map(c=>c.path),placements:review.testTransfer.placements,verification:review.verification,
    publication:'not_performed',device:'not_run',sdk: 'not_run'};
  await write('review.json',JSON.stringify(evidence,null,2)+'\n');
  const program=flutter?'flutter':'dart';
  await write('CHECKS.md',`# Independent ${flutter?'Flutter':'Dart'} fixture checks\n\nThese are authored package fixtures, not a complete mobile application or live AI transfer.\nNo compiler, dependency installation, test runner or device was executed by the generator.\n\nWith the appropriate SDK installed, run from EACH of source, destination-before and destination-after:\n\n\`\`\`sh\n${program} pub get\n${program} analyze\n${program} test\n\`\`\`\n\nDependency installation uses the package registry and may run toolchain hooks. Use an\nisolated disposable environment without credentials. This script does not provide a sandbox.\nRecord command exit codes and toolchain versions; do not treat review.json as a runtime result.\nThe before directory deliberately contains an existing test file to exercise collision protection.\n`);
  return {directory:target,...evidence};
}

/** Parse the explicit fixture CLI; unknown flags are errors rather than accidental target paths. */
async function main() {
  const [output,flag,...extra]=process.argv.slice(2);
  if(!output||output.startsWith('--')||extra.length||(flag!==undefined&&flag!=='--flutter'))throw new Error('Usage: node scripts/materialize-dart-fixture.mjs NEW_DIRECTORY [--flutter]');
  console.log(JSON.stringify(await materializeDartFixture(output,{flutter:flag==='--flutter'}),null,2));
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url) {
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
}
