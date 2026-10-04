/**
 * @file Assertion-preserving Dart/Flutter test discovery and relocation.
 * Supports one manifest-backed source/destination package and ordinary Dart library imports.
 * Only directive URI spans change in copied tests/helpers. No Dart is executed, no tests are
 * generated, no pubspec is rewritten and declaration/version matching is not runtime proof.
 */
import path from 'node:path';
import {createHash} from 'node:crypto';
import {eligiblePath,LIMITS,looksSensitive} from './policy.mjs';
import {profileProject,insideRoot} from './project-profile.mjs';
import {dartDirectives,dartPackage,resolveDart,sourceTokens,dependencyClosure} from './source-graph.mjs';

const TEST_NAME=/_test\.dart$/;
const CONFIG=/(?:^|\/)(?:dart_test\.yaml|flutter_test_config\.dart|pubspec_overrides\.yaml|build\.yaml)$/;
const RESOURCE_APIS=new Set(['File','Directory','Process','DynamicLibrary','rootBundle','AssetBundle','AssetImage','ExactAssetImage','matchesGoldenFile','matchesReferenceImage','MethodChannel','EventChannel','spawnUri']);
/** Hash exact non-URI source bytes; this is evidence of preservation, not test execution. */
const hash=text=>createHash('sha256').update(text).digest('hex');
/** Strip a validated project root without changing package-relative directory structure. */
const relative=(root,p)=>root?p.slice(root.length+1):p;
/** Keep test helpers inside the default test directory, never copy source production as a test double. */
const inTests=(component,p)=>relative(component.root,p).startsWith('test/');
/** Inventory ownership comes from the nearest pubspec, not just a shared path prefix. */
const owned=(profile,component,p)=>dartPackage(profile,p)?.root===component.root;
/** Pick a single Dart project from actual selected paths. Mixed selections need an explicit scope. */
function selectedPackage(profile,paths) {
  const owners=paths.map(p=>dartPackage(profile,p));
  if(!paths.length||owners.some(c=>!c)||new Set(owners.map(c=>c.root)).size!==1)return null;
  return owners[0];
}
/** Return pure metadata in the test plan; all objects are derived from inspected repository files. */
function descriptor(component) {
  return component?{root:component.root,name:component.name,kind:component.kind,manifest:component.manifest,dependencies:component.dependencies,pubspecComplete:component.pubspecComplete}:null;
}
/** Enumerate parsed dependency evidence without evaluating configuration or strings. */
function packageGraph(repo,profile,component) {
  const files=new Map(repo.files.map(f=>[f.path,f])),nodes=new Map(),adjacency=new Map();
  for(const file of repo.files) {
    if(!file.path.endsWith('.dart')||!owned(profile,component,file.path))continue;
    const parsed=dartDirectives(file);
    const refs=parsed.directives.map(r=>({...r,...resolveDart(file.path,r.specifier,profile,files)}));
    nodes.set(file.path,{file,parsed,refs});
    adjacency.set(file.path,new Set(refs.flatMap(r=>r.targets)));
  }
  return {files,nodes,adjacency};
}
/** Fixed diagnostics carry a known path only, never source text, provider errors or secret values. */
function problem(list,code,p='') {list.push(p?`${code}: ${p}`:code);}

/**
 * Discover native tests before model-context selection. Return null for other languages so the
 * existing JS/TS adapter stays authoritative. No destination test is needed to infer Dart's
 * default test/ layout; custom configuration is a separate, explicitly blocked case.
 */
export function discoverDartTests(source,destination,roots,landing) {
  if(!roots.length||!roots.every(p=>p.endsWith('.dart')))return null;
  const sp=profileProject(source),dp=profileProject(destination);
  const from=selectedPackage(sp,roots),to=selectedPackage(dp,landing.filter(p=>p.endsWith('.dart')));
  const issues=[],tests=[],support=[],featurePaths=[];
  const plan={adapter:'dart',source:descriptor(from),destination:descriptor(to),tests,support,featurePaths,
    requiredSource:[],requiredDestination:[],coveredNativePaths:[],issues,scope:'selected-dart-package',
    warnings:['Static import/name discovery is not full test coverage. Package declarations are checked, not resolved version compatibility. Native builds, widget behavior and device execution remain not_run.']};
  if(!from||!to||landing.some(p=>!p.endsWith('.dart'))) {problem(issues,'dart_package_selection_required');return plan;}
  if(sp.omittedComponents||dp.omittedComponents||!from.pubspecComplete||!to.pubspecComplete)problem(issues,'dart_manifest_resolution_required');
  plan.requiredSource.push(from.manifest);plan.requiredDestination.push(to.manifest);
  const graph=packageGraph(source,sp,from);
  for(const side of ['source','destination']) {
    const repo=side==='source'?source:destination,profile=side==='source'?sp:dp,component=side==='source'?from:to;
    const available=new Set(repo.files.map(f=>f.path));
    for(const p of repo.inventory) {
      if(!owned(profile,component,p))continue;
      if(CONFIG.test(p)) {
        problem(issues,'dart_custom_test_or_build_configuration',p);
        (side==='source'?plan.requiredSource:plan.requiredDestination).push(p);
      }
      if(eligiblePath(p)&&!available.has(p))problem(issues,'dart_snapshot_incomplete',p);
    }
  }
  const production=new Set(dependencyClosure(graph,roots));
  for(const p of production)if(!relative(from.root,p).startsWith('lib/'))problem(issues,'dart_source_must_be_library',p);
  const reached=new Set(production);let changed=true;
  while(changed) {changed=false;for(const [p,refs] of graph.adjacency)if(!reached.has(p)&&[...refs].some(r=>reached.has(r))){reached.add(p);changed=true;}}
  const stems=new Set(roots.map(p=>path.posix.basename(p,'.dart')));
  for(const [p,node] of graph.nodes) {
    if(inTests(from,p)) {
      plan.coveredNativePaths.push(p);
      // Malformed/unresolved test headers cannot establish that a test is unrelated.
      if(node.parsed.issues.length||node.refs.some(r=>r.kind==='unresolved'))problem(issues,'dart_test_dependency_discovery_incomplete',p);
      if(TEST_NAME.test(p)&&(reached.has(p)||stems.has(path.posix.basename(p,'_test.dart'))))tests.push({path:p,evidence:reached.has(p)?'reverse-import':'matching-name'});
    } else if(relative(from.root,p).startsWith('integration_test/'))problem(issues,'dart_device_test_adapter_required',p);
  }
  const closure=dependencyClosure(graph,tests.map(t=>t.path));
  for(const p of closure) {
    if(inTests(from,p)) {if(!tests.some(t=>t.path===p))support.push(p);}
    else production.add(p);
  }
  for(const p of production)if(!relative(from.root,p).startsWith('lib/'))problem(issues,'dart_source_must_be_library',p);
  featurePaths.push(...[...production].sort());
  for(const p of [...production,...closure]) {
    const node=graph.nodes.get(p);
    if(!node){problem(issues,'dart_nonlibrary_dependency',p);continue;}
    if(node.parsed.issues.length)problem(issues,'dart_unsupported_library_directive',p);
    if(node.refs.some(r=>r.conditional))problem(issues,'dart_conditional_library_requires_platform_verification',p);
    if(node.refs.some(r=>r.kind==='unresolved'))problem(issues,'dart_unresolved_source_import',p);
    if(sourceTokens(node.file.content).tokens.some(t=>t.kind==='word'&&RESOURCE_APIS.has(t.value)))problem(issues,'dart_resource_or_platform_setup_required',p);
    for(const r of node.refs) {
      if(r.kind==='external'&&(!from.dependencies.includes(r.package)||!to.dependencies.includes(r.package)))problem(issues,'dart_dependency_not_declared_in_both_packages',p);
    }
  }
  if(tests.length) {
    const runners=new Set(closure.flatMap(p=>(graph.nodes.get(p)?.refs??[]).filter(r=>r.kind==='external'&&['test','flutter_test'].includes(r.package)).map(r=>r.package)));
    if(!runners.size)problem(issues,'dart_test_runner_not_identified');
    if(runners.has('flutter_test')&&to.kind!=='flutter')problem(issues,'flutter_test_requires_flutter_destination');
  }
  plan.requiredSource=[...new Set([...plan.requiredSource,...featurePaths,...tests.map(t=>t.path),...support])].sort();
  plan.requiredDestination=[...new Set(plan.requiredDestination)].sort();
  plan.coveredNativePaths.sort();tests.sort((a,b)=>a.path.localeCompare(b.path));support.sort();
  plan.issues=[...new Set(issues)].sort();
  return plan;
}

/** Replace exactly validated literal-content ranges and preserve every other source byte. */
export function rewriteDartUris(text,edits) {
  let last=text.length,result=text;
  for(const e of [...edits].sort((a,b)=>b.start-a.start)) {
    if(!Number.isInteger(e.start)||!Number.isInteger(e.end)||e.start<0||e.end<e.start||e.end>last||text.slice(e.start,e.end)!==e.before||!/^[-A-Za-z0-9_./:]+$/.test(e.value))throw new Error('Invalid Dart URI edit');
    result=result.slice(0,e.start)+e.value+result.slice(e.end);last=e.start;
  }
  return result;
}
/** Compute a preservation digest after masking URI ranges only, without normalizing whitespace/comments. */
function preservedBody(text) {
  const d=dartDirectives({content:text});
  if(d.issues.length)throw new Error('Unsupported Dart header');
  let out=text;
  for(const r of [...d.directives].sort((a,b)=>b.start-a.start))out=out.slice(0,r.start)+'<REPOT_URI>'+out.slice(r.end);
  return hash(out);
}
/** Detect both whole-path and file/directory collisions, including case-folded filenames. */
function collides(p,inventory) {
  const key=p.toLowerCase();
  return inventory.some(q=>{q=q.toLowerCase();return q===key||q.startsWith(key+'/')||key.startsWith(q+'/');});
}

/**
 * Move source tests and their Dart helpers using only inspected implementation mappings.
 * Caller recomputes the discovery plan from pinned snapshots. Output is all-or-nothing for
 * native additions; an invalid proposal never publishes a partial set of native tests.
 */
export function transplantDartTests(changes,source,destination,plan,context) {
  const blockers=[...plan.issues],placements=[],adaptations=[],additions=[],mapping=new Map();
  const from=plan.source,to=plan.destination;
  const report={adapter:'dart',status:'none_found',discovered:plan.tests.length,placements,adaptations,blockers,warnings:plan.warnings,
    framework:{from:from?.kind==='flutter'?'flutter_test/test':'test',to:to?.kind==='flutter'?'flutter_test/test':'test',conversion:false,runtimeVerification:'not_run'},
    assertionPolicy:'Only parsed import/export URI literal spans change. All assertion, helper, annotation and comment bytes outside those spans are preserved. No tests executed.',
    verification:{sourceBaseline:'not_run',destinationBaseline:'not_run',transferredTests:'not_run',destinationRegression:'not_run'}};
  /** Do not expose incomplete additions on a blocked transfer; publication remains controlled by exportable. */
  function done() {
    report.blockers=[...new Set(blockers)].sort();
    report.status=report.blockers.length?'blocked':plan.tests.length?'included':'none_found';
    const fixable=['dart_implementation_mapping_required','dart_multiple_sources_one_target','dart_generated_import_unresolved','dart_test_dependency_unmapped'];
    if(!plan.issues.length&&report.blockers.length&&report.blockers.every(b=>fixable.includes(b.split(':')[0]))) {
      report.proposalRepairCode=report.blockers.some(b=>!b.startsWith('dart_generated_import_unresolved'))?'proposal_dart_mapping':'proposal_dart_import';
      const index=changes.findIndex(c=>report.blockers.includes('dart_generated_import_unresolved: '+c.path));
      if(report.proposalRepairCode==='proposal_dart_import'&&index>=0)report.proposalRepairChangeIndex=index;
    }
    return {changes:report.blockers.length?changes:[...changes,...additions],report};
  }
  if(!from||!to)return done();
  const sourceFiles=new Map(source.files.map(f=>[f.path,f])),sp=profileProject(source),dp=profileProject(destination);
  const seenSource=new Set(context.source.map(f=>f.path)),seenDestination=new Set(context.destination.map(f=>f.path));
  for(const p of plan.requiredSource)if(!seenSource.has(p))problem(blockers,'dart_context_missing',p);
  for(const p of plan.requiredDestination)if(!seenDestination.has(p))problem(blockers,'dart_destination_context_missing',p);
  for(const c of changes) {
    if(inTests(to,c.path)||CONFIG.test(c.path)||c.path===to.manifest||c.sourcePaths.some(p=>inTests(from,p)))problem(blockers,'dart_model_must_not_modify_tests_or_runner',c.path);
  }
  for(const p of plan.featurePaths) {
    const cited=changes.filter(c=>c.sourcePaths.includes(p)&&c.path.endsWith('.dart')&&owned(dp,to,c.path)&&relative(to.root,c.path).startsWith('lib/'));
    const exact=cited.filter(c=>c.path===path.posix.join(to.root,relative(from.root,p)));
    const named=cited.filter(c=>path.posix.basename(c.path)===path.posix.basename(p));
    const preferred=exact.length?exact:named.length?named:cited;
    if(preferred.length===1)mapping.set(p,preferred[0].path);
    else problem(blockers,'dart_implementation_mapping_required',p);
  }
  const copied=[...plan.tests.map(t=>t.path),...plan.support];
  // A namespaced bundle is still discovered by the default test runner. Move the whole
  // bundle together only when needed; unrelated destination tests are never overwritten.
  const inventory=[...destination.inventory,...changes.map(c=>c.path)];
  let prefix='';
  if(copied.some(p=>collides(path.posix.join(to.root,relative(from.root,p)),inventory))) {
    const key=hash(from.name+':'+plan.featurePaths.join('|')).slice(0,12);
    for(let n=0;n<8;n++) {
      const candidate='repot_'+key+(n?'_'+n:'')+'/';
      if(!copied.some(p=>collides(path.posix.join(to.root,'test',candidate,relative(from.root,p).slice(5)),inventory))){prefix=candidate;break;}
    }
    if(!prefix)problem(blockers,'dart_test_destination_collision');
  }
  for(const p of copied)mapping.set(p,prefix?path.posix.join(to.root,'test',prefix,relative(from.root,p).slice(5)):path.posix.join(to.root,relative(from.root,p)));
  const targets=new Map();
  for(const [src,dst] of mapping) {const old=targets.get(dst.toLowerCase());if(old&&old!==src)problem(blockers,'dart_multiple_sources_one_target',dst);targets.set(dst.toLowerCase(),src);}
  const occupied=[...destination.inventory,...changes.map(c=>c.path)];
  // Validate actual generated library imports against the final inventory, not the donor's package name.
  const finalFiles=new Map([...destination.files,...changes].map(f=>[f.path,f]));
  for(const c of changes.filter(c=>c.path.endsWith('.dart'))) {
    if(!owned(dp,to,c.path)||!relative(to.root,c.path).startsWith('lib/')){problem(blockers,'dart_generated_file_outside_selected_library',c.path);continue;}
    const d=dartDirectives(c);
    if(d.issues.length)problem(blockers,'dart_generated_directive_unsupported',c.path);
    if(d.directives.some(r=>r.conditional))problem(blockers,'dart_generated_conditional_platform_directive',c.path);
    if(sourceTokens(c.content).tokens.some(t=>t.kind==='word'&&RESOURCE_APIS.has(t.value)))problem(blockers,'dart_generated_resource_or_platform_setup_required',c.path);
    for(const r of d.directives) {
      const resolved=resolveDart(c.path,r.specifier,dp,finalFiles);
      if(resolved.kind==='unresolved'||resolved.kind==='external'&&!to.dependencies.includes(resolved.package))problem(blockers,'dart_generated_import_unresolved',c.path);
    }
  }
  for(const p of [...plan.tests.map(t=>t.path),...plan.support]) {
    const f=sourceFiles.get(p),target=mapping.get(p);
    if(!f||!target||!inTests(from,p)||!p.endsWith('.dart')){problem(blockers,'dart_test_mapping_required',p);continue;}
    if(!eligiblePath(target)||collides(target,occupied)){problem(blockers,'dart_test_destination_collision',target);continue;}
    const d=dartDirectives(f),edits=[];
    if(d.issues.length){problem(blockers,'dart_unsupported_test_directive',p);continue;}
    for(const r of d.directives) {
      const resolved=resolveDart(p,r.specifier,sp,sourceFiles);
      if(resolved.kind==='builtin')continue;
      if(resolved.kind==='external') {
        if(!from.dependencies.includes(resolved.package)||!to.dependencies.includes(resolved.package))problem(blockers,'dart_dependency_not_declared_in_both_packages',p);
        continue;
      }
      const mapped=mapping.get(resolved.targets[0]);
      if(resolved.kind!=='resolved'||!mapped){problem(blockers,'dart_test_dependency_unmapped',p);continue;}
      let value;
      if(r.specifier.startsWith('package:')) {
        const tail=relative(to.root,mapped);
        if(!tail.startsWith('lib/')){problem(blockers,'dart_package_uri_must_target_lib',p);continue;}
        value='package:'+to.name+'/'+tail.slice(4);
      } else value=path.posix.relative(path.posix.dirname(target),mapped);
      if(value!==r.specifier)edits.push({start:r.start,end:r.end,before:r.specifier,value});
    }
    let content;
    try {
      content=rewriteDartUris(f.content,edits);
      if(preservedBody(content)!==preservedBody(f.content))throw new Error('Test body changed');
    } catch {problem(blockers,'dart_preservation_check_failed',p);continue;}
    if(Buffer.byteLength(content)>LIMITS.fileBytes||looksSensitive(content)){problem(blockers,'dart_test_content_rejected',p);continue;}
    additions.push({path:target,action:'add',content,before:null,baseHash:null,reason:'Preserve Dart test/helper; update resolved library URI spans only.',sourcePaths:[p]});
    occupied.push(target);
    placements.push({sourcePath:p,destinationPath:target,kind:TEST_NAME.test(p)?'test':'support',preservedBodySha256:preservedBody(content)});
    if(edits.length)adaptations.push({sourcePath:p,kind:'dart-library-uri',editCount:edits.length});
  }
  if(changes.length+additions.length>32||[...changes,...additions].reduce((n,c)=>n+Buffer.byteLength(c.content),0)>120000)problem(blockers,'dart_combined_patch_budget_exceeded');
  return done();
}
