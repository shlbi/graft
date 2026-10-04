/**
 * @file Read-only integration plans: explicit source/landing paths, dependency closure, mobile boundaries,
 * context budgets and honest verification requirements. Plans never run a build or mutate a repository.
 */
import path from 'node:path';
import { LIMITS, eligiblePath } from './policy.mjs';
import { sourceGraph, dependencyClosure } from './source-graph.mjs';
import { isProjectTest, componentsForPath, languageForPath, insideRoot } from './project-profile.mjs';
import { Fault } from './core-base.mjs';
export const SELECTION_LIMIT = 20;
/** Canonical, bounded file selection for hashes and immutable review context; folders are not silently expanded. */
export function normalizeSelection(value) {
  if(value===undefined)return undefined;
  if(!Array.isArray(value)||!value.length||value.length>SELECTION_LIMIT||value.some(p=>!eligiblePath(p)))throw new Fault('Select 1–20 eligible repository-relative file paths.',422);
  if(new Set(value.map(p=>p.toLowerCase())).size!==value.length)throw new Fault('Selected paths contain duplicates or case collisions.',422);
  return [...value].sort();
}
/** Verify explicit paths are actually inspected, not merely present in an untrusted filename inventory. */
function selection(repo,explicit,fallback) {
  const names=new Set(repo.files.map(f=>f.path)),chosen=normalizeSelection(explicit)??fallback;
  if(chosen.some(p=>!names.has(p)))throw new Fault('A selected file is not in the inspected repository snapshot.',422);
  return chosen;
}
/** Manifest/platform files associated with chosen components, including native configuration for cross-platform apps. */
function configurationPaths(repo,profile,roots) {
  const components=[...new Map(roots.flatMap(p=>componentsForPath(profile,p)).map(c=>[c.root+':'+c.kind,c])).values()];
  const names=repo.files.map(f=>f.path);
  return [...new Set(components.flatMap(c=>[...c.evidence,...names.filter(p=>insideRoot(p,c.root)&&(componentsForPath(profile,p).some(owner=>owner.root===c.root)||(['flutter','react-native','expo'].includes(c.kind)&&/^(?:android|ios)\//.test(p.slice(c.root?c.root.length+1:0))))&&/(?:^|\/)(?:pubspec\.yaml|analysis_options\.yaml|dart_test\.yaml|flutter_test_config\.dart|app\.(?:json|config\.[cm]?[jt]s)|AndroidManifest\.xml|Info\.plist|Podfile|Package\.swift|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|project\.pbxproj)$/.test(p))]))].sort();
}
/** Verification commands are suggestions for a separately authorized isolated runner, never shell input. */
export function verificationPlan(profile,repo,roots) {
  const components=[...new Map(roots.flatMap(p=>componentsForPath(profile,p)).map(c=>[c.root+':'+c.kind,c])).values()];
  const checks=[];
  /** Add a toolchain-specific check with a concrete working directory and no passing claim. */
  function add(component,kind,program,args,requirements=[]) {checks.push({projectRoot:component.root||'.',kind,program,args,requirements,status:'not_run',requiresIsolation:true});}
  for(const c of components) {
    if(c.kind==='flutter'){add(c,'analysis','flutter',['analyze'],['Flutter SDK','resolved packages']);add(c,'tests','flutter',['test'],['Flutter SDK','resolved packages']);add(c,'device',null,[],['target platform','emulator or physical device','permissions/lifecycle/native plugins']);}
    else if(c.kind==='dart'){add(c,'analysis','dart',['analyze'],['Dart SDK','resolved packages']);add(c,'tests','dart',['test'],['Dart SDK','test dependency']);}
    else if(c.kind==='go')add(c,'tests','go',['test','./...'],['Go toolchain','resolved modules']);
    else if(c.kind==='python')add(c,'tests',null,[],['Python environment','select the declared test runner']);
    else if(c.kind==='swift-package')add(c,'tests','swift',['test'],['Swift toolchain','resolved Swift packages']);
    else if(c.kind==='apple-app')add(c,'build-and-device',null,[],['macOS/Xcode','scheme','simulator destination','target membership','entitlements']);
    else if(c.kind==='android'||c.kind==='jvm')add(c,'build-and-tests',null,[],['JDK','Gradle/Maven project tasks','Android SDK when applicable','device tests separately']);
    else if(['dotnet','maui'].includes(c.kind)){add(c,'tests','dotnet',['test'],['.NET SDK','resolved packages']);if(c.kind==='maui')add(c,'device',null,[],['MAUI workloads','platform SDK','device or emulator']);}
    else if(c.kind==='rust')add(c,'tests','cargo',['test'],['Rust toolchain','resolved crates']);
    else if(['node','web','react-native','expo'].includes(c.kind)) {
      let scripts={};try{scripts=JSON.parse(repo.files.find(f=>f.path===c.manifest)?.content??'{}').scripts??{};}catch{}
      for(const name of ['test','build'])if(typeof scripts[name]==='string'&&scripts[name].trim())add(c,name,'npm',['run',name],['Node.js','declared package manager/dependencies; adapt npm if needed']);
      if(c.mobile)add(c,'device',null,[],['iOS/Android toolchain','native dependency linking','platform variants','device or emulator']);
    }else add(c,'integration',null,[],['select language/framework-specific compiler and test runner']);
  }
  return checks;
}
/**
 * Build dependency-aware priorities before budget selection. Large closures are reported as pending
 * work groups, not silently truncated and called complete. Existing snapshot/output limits still apply.
 */
export function planFeature(source,destination,feature,{sourcePaths,destinationPaths,sourceRoots=[],destinationRoots=[],jsReferences=null}={}) {
  const sg=sourceGraph(source,{jsReferences}),dg=sourceGraph(destination,{jsReferences});
  const roots=selection(source,sourcePaths,sourceRoots),landing=selection(destination,destinationPaths,destinationRoots);
  const production=dependencyClosure(sg,roots).filter(p=>!isProjectTest(p));
  // Reverse reachability preserves wrapper/helper tests, not only filename similarity.
  const reached=new Set(production);let changed=true;
  while(changed){changed=false;for(const [p,refs]of sg.adjacency)if(!reached.has(p)&&[...refs].some(r=>reached.has(r))){reached.add(p);changed=true;}}
  const tests=[...reached].filter(isProjectTest).sort();
  const requiredSource=[...new Set([...roots,...production,...dependencyClosure(sg,tests),...configurationPaths(source,sg.profile,roots)])];
  const requiredDestination=[...new Set([...landing,...dependencyClosure(dg,landing),...configurationPaths(destination,dg.profile,landing)])];
  const sourceSet=new Set(requiredSource),destinationSet=new Set(requiredDestination);
  const issues=[...sg.issues.filter(i=>sourceSet.has(i.path)).map(i=>({...i,side:'source'})),...dg.issues.filter(i=>destinationSet.has(i.path)).map(i=>({...i,side:'destination'}))];
  const sourceLanguages=[...new Set(roots.map(languageForPath).filter(Boolean))],destLanguages=[...new Set(landing.map(languageForPath).filter(Boolean))];
  const crossLanguage=sourceLanguages.length>0&&destLanguages.length>0&&!sourceLanguages.some(l=>destLanguages.includes(l)||['javascript','typescript'].includes(l)&&destLanguages.some(x=>['javascript','typescript'].includes(x)));
  if(crossLanguage)issues.push({side:'transfer',code:'cross_language_semantic_port_requires_review'});
  // Partition only for planning; do not execute independent partial publications.
  const groups=[];let current=[],bytes=0;
  for(const p of requiredSource){const size=Buffer.byteLength(source.files.find(f=>f.path===p)?.content??'','utf8');if(current.length&&(bytes+size>LIMITS.contextBytes/2||current.length>=36)){groups.push({paths:current,bytes});current=[];bytes=0;}current.push(p);bytes+=size;}
  if(current.length)groups.push({paths:current,bytes});
  const mobile=[...sg.profile.components,...dg.profile.components].some(c=>c.mobile);
  return {version:1,feature,selection:{...(sourcePaths?{sourcePaths:roots}:{}),...(destinationPaths?{destinationPaths:landing}:{})},
    roots,landing,requiredSource,requiredDestination,relatedTests:tests,projects:{source:sg.profile,destination:dg.profile},
    dependencies:sg.edges.filter(e=>sourceSet.has(e.from)).slice(0,80).map(e=>({...e,targets:e.targets.slice(0,8),targetCount:e.targets.length})),issues:issues.slice(0,100),omittedIssues:Math.max(0,issues.length-100),
    workGroups:groups.slice(0,20),omittedGroups:Math.max(0,groups.length-20),crossLanguage,
    platformChecks:mobile?['native dependency registration','permissions and entitlements','platform-specific source variants','assets and resource registration','navigation and app lifecycle','device/emulator acceptance']:[],
    verification:verificationPlan(dg.profile,destination,landing),
    scope:'bounded-static-plan',notice:'Dependency evidence and work groups are planning, not a compiler result or completed multi-stage transfer. Unresolved native/module/build conditions require toolchain verification.'};
}
/** Record actual selected-context omissions after the shared byte/file budget is applied. */
export function finalizePlan(plan,context) {
  const source=new Set(context.source.map(f=>f.path)),destination=new Set(context.destination.map(f=>f.path));
  const missingSource=plan.requiredSource.filter(p=>!source.has(p)),missingDestination=plan.requiredDestination.filter(p=>!destination.has(p));
  return {...plan,contextCoverage:{complete:!missingSource.length&&!missingDestination.length,missingSource,missingDestination},
    readiness:missingSource.length||missingDestination.length?'needs_additional_context':'ready_for_bounded_draft'};
}

/** Compact public/model metadata; full file priorities remain local to context selection. */
export function compactPlan(plan) {
  const summarize = profile => ({languages:profile.languages,components:profile.components.map(c=>({root:c.root,kind:c.kind,evidence:c.evidence,evidenceRead:c.evidenceRead})).slice(0,12),omittedComponents:profile.omittedComponents+Math.max(0,profile.components.length-12)});
  const result={version:plan.version,selection:plan.selection,roots:plan.roots,landing:plan.landing,
    projects:{source:summarize(plan.projects.source),destination:summarize(plan.projects.destination)},
    dependencyFileCount:plan.requiredSource.length,relatedTests:plan.relatedTests.slice(0,30),relatedTestCount:plan.relatedTests.length,
    issues:plan.issues.slice(0,24),omittedIssues:plan.omittedIssues+Math.max(0,plan.issues.length-24),crossLanguage:plan.crossLanguage,
    workGroupCount:plan.workGroups.length+plan.omittedGroups,platformChecks:plan.platformChecks,verification:plan.verification.slice(0,12),
    ...(plan.contextCoverage?{contextCoverage:{complete:plan.contextCoverage.complete,missingSource:plan.contextCoverage.missingSource.slice(0,30),missingDestination:plan.contextCoverage.missingDestination.slice(0,30),missingSourceCount:plan.contextCoverage.missingSource.length,missingDestinationCount:plan.contextCoverage.missingDestination.length},readiness:plan.readiness}:{}),
    scope:plan.scope,notice:plan.notice};
  // Defensive upper bound even for maliciously long names/paths. Never claim complete metadata after truncation.
  if(Buffer.byteLength(JSON.stringify(result),'utf8')>24000)return {version:1,scope:plan.scope,readiness:'metadata_limit',metadataTruncated:true,notice:plan.notice};
  return result;
}

/**
 * Allocate one shared text budget across source and destination instead of rejecting a 60KB
 * source file merely because half of the old 110KB budget was 55KB. Never cut a file in half.
 * Required files are interleaved first; fallback context cannot evict required context.
 */
export function selectContext(source,destination,{sourcePriority,destinationPriority,sourceFallback=[],destinationFallback=[]}) {
  const maps={source:new Map(source.files.map(f=>[f.path,f])),destination:new Map(destination.files.map(f=>[f.path,f]))};
  const selected={source:new Map(),destination:new Map()};let used=0;
  /** Include an entire inspected file exactly once while preserving the aggregate byte ceiling. */
  function add(side,p) {
    const f=maps[side].get(p);if(!f||selected[side].has(p)||selected[side].size>=64)return;
    const n=Buffer.byteLength(f.content,'utf8');if(used+n>LIMITS.contextBytes)return;
    selected[side].set(p,f);used+=n;
  }
  for(let i=0;i<Math.max(sourcePriority.length,destinationPriority.length);i++){add('source',sourcePriority[i]);add('destination',destinationPriority[i]);}
  for(let i=0;i<Math.max(sourceFallback.length,destinationFallback.length);i++){add('source',sourceFallback[i]);add('destination',destinationFallback[i]);}
  return {source:[...selected.source.values()].map(({path,content,hash})=>({path,content,hash})),destination:[...selected.destination.values()].map(({path,content,hash})=>({path,content,hash}))};
}
