/**
 * @file Bounded static dependency evidence across source languages, with exact Dart directive spans.
 * This is not a compiler or universal symbol resolver. Ambiguous/unsupported constructs stay visible.
 * No repository code, build configuration, subprocess or filesystem import is ever executed.
 */
import path from 'node:path';
import { eligiblePath } from './policy.mjs';
import { languageForPath, profileProject, componentsForPath, insideRoot } from './project-profile.mjs';
const JS = /\.[cm]?[jt]sx?$/i;
/** Tokenize identifiers/literals/comments without interpreting string contents or template expressions. */
export function sourceTokens(text, hashComments = false) {
  const tokens = [], issues = []; let i = 0;
  while (i < text.length) {
    const start = i, c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    if (text.startsWith('//',i) || (hashComments && c === '#')) { while(i<text.length && text[i] !== '\n')i++; continue; }
    if (text.startsWith('/*',i)) {
      i+=2;let depth=1;
      while(i<text.length && depth){if(text.startsWith('/*',i)){depth++;i+=2;}else if(text.startsWith('*/',i)){depth--;i+=2;}else i++;}
      if(depth)issues.push('unterminated_comment');continue;
    }
    const raw = (c==='r' || c==='R') && ['"',"'"].includes(text[i+1]);
    const quote = raw ? text[++i] : c;
    if(['"',"'",'`'].includes(quote)) {
      const triple=text.slice(i,i+3)===quote.repeat(3), delimiter=triple?quote.repeat(3):quote;
      i+=delimiter.length;const valueStart=i;let escaped=false;
      while(i<text.length && !text.startsWith(delimiter,i)) {
        if(!raw && text[i]==='\\'){escaped=true;i+=Math.min(2,text.length-i);}else i++;
      }
      const value=text.slice(valueStart,i),closed=i<text.length;i+=closed?delimiter.length:0;
      if(!closed)issues.push('unterminated_literal');
      tokens.push({kind:'string',value,start,end:i,valueStart,valueEnd:closed?i-delimiter.length:i,static:closed&&!escaped&&!triple&&quote!=='`'&&!value.includes('$')});continue;
    }
    if(/[A-Za-z_$]/.test(c)){i++;while(i<text.length && /[A-Za-z0-9_$]/.test(text[i]))i++;tokens.push({kind:'word',value:text.slice(start,i),start,end:i});continue;}
    i++;tokens.push({kind:'symbol',value:c,start,end:i});
  }
  return {tokens,issues};
}
/** Extract top-level Dart import/export/part URIs and exact literal-content offsets; preserve every conditional branch. */
export function dartDirectives(file) {
  const {tokens,issues}=sourceTokens(file.content),directives=[];let braces=0;
  for(let i=0;i<tokens.length;i++) {
    const t=tokens[i];
    if(t.value==='{'){braces++;continue;}if(t.value==='}'){braces--;continue;}
    if(braces!==0 || t.kind!=='word' || !['import','export','part'].includes(t.value))continue;
    const end=tokens.findIndex((n,j)=>j>i && n.value===';');
    if(end===-1){issues.push('unterminated_directive');break;}
    const body=tokens.slice(i+1,end),conditional=body.some(n=>n.kind==='word'&&n.value==='if');
    if(t.value==='part'&&body[0]?.value==='of')issues.push('part_of_requires_library_context');
    else {
      const strings=body.filter(n=>n.kind==='string');
      if(!strings.length || body[0]?.kind!=='string')issues.push('unsupported_directive');
      for(const n of strings){if(!n.static)issues.push('nonliteral_directive');else directives.push({kind:t.value,specifier:n.value,start:n.valueStart,end:n.valueEnd,conditional});}
    }
    i=end;
  }
  return {directives,issues:[...new Set(issues)]};
}
/** Find exactly one package component for a source path, never a similarly named sibling project. */
export function dartPackage(profile,filePath) {
  const candidates=componentsForPath(profile,filePath).filter(c=>['dart','flutter'].includes(c.kind));
  return candidates.length===1 ? candidates[0] : null;
}
/** Resolve a Dart URI only inside its own package or as an explicitly external library. */
export function resolveDart(filePath,specifier,profile,files) {
  if(specifier.startsWith('dart:'))return {kind:'builtin',targets:[]};
  const component=dartPackage(profile,filePath),pkg=/^package:([a-z][a-z0-9_]*)\/(.+)$/.exec(specifier);
  let target;
  if(pkg){if(pkg[2].split('/').some(p=>!p||p==='.'||p==='..'))return {kind:'unresolved',targets:[]};if(!component || pkg[1]!==component.name)return {kind:'external',package:pkg[1],targets:[]};target=path.posix.join(component.root,'lib',pkg[2]);}
  else if(/^[a-z][a-z0-9+.-]*:|[?#%\\]/i.test(specifier) || specifier.startsWith('/'))return {kind:'unresolved',targets:[]};
  else target=path.posix.normalize(path.posix.join(path.posix.dirname(filePath),specifier));
  if(!eligiblePath(target) || (component && !insideRoot(target,component.root)))return {kind:'unresolved',targets:[]};
  return files.has(target)?{kind:'resolved',targets:[target]}:{kind:'unresolved',targets:[],candidate:target};
}
/** Extract import lines from tokens so comments and string bodies cannot invent dependencies. */
function importWords(file,language) {
  const {tokens,issues}=sourceTokens(file.content,language==='python');const imports=[];
  for(let i=0;i<tokens.length;i++) {
    const t=tokens[i];if(t.kind!=='word'||!['import','from','use','mod','require_relative'].includes(t.value))continue;
    // Non-Dart recognizers are line-scoped hints, never rewriting authority.
    const end=file.content.indexOf('\n',t.end),lineEnd=end<0?file.content.length:end;
    const line=tokens.filter((n,j)=>j>i&&n.start<lineEnd&&n.value!==';');
    imports.push({kind:t.value,tokens:line,start:t.start});
  }
  return {imports,issues};
}
/** Build a deterministic graph. JS uses the existing parser callback; native fallbacks report their limitations. */
export function sourceGraph(repo,{jsReferences=null}={}) {
  const files=new Map(repo.files.map(f=>[f.path,f])),profile=profileProject(repo),edges=[],issues=[];
  const adjacency=new Map([...files.keys()].map(p=>[p,new Set()]));
  const MAX_EDGES=8000;
  /** Add only inspected targets and deduplicate edges; unresolved evidence never becomes a fake file. */
  function edge(from,kind,targets=[],specifier='') {
    if(edges.length>=MAX_EDGES){issues.push({path:from,code:'edge_budget_exceeded'});return;}
    specifier=String(specifier).slice(0,240);
    edges.push({from,kind,targets,specifier});for(const to of targets)if(files.has(to))adjacency.get(from).add(to);
    if(['unresolved','ambiguous'].includes(kind))issues.push({path:from,code:kind,specifier});
  }
  /** Resolve one candidate file, keeping ambiguity explicit rather than selecting the first match. */
  function candidates(from,paths,specifier) {const found=[...new Set(paths)].filter(p=>eligiblePath(p)&&files.has(p));edge(from,found.length===1?'resolved':found.length?'ambiguous':'unresolved',found,specifier);}
  for(const file of repo.files) {
    const p=file.path,language=languageForPath(p);if(!language)continue;
    if(JS.test(p)) {
      if(jsReferences){const refs=jsReferences(file,files);for(const r of refs)edge(p,r.target?'resolved':r.internal?'unresolved':'external',r.target?[r.target]:[],r.specifier);for(const code of refs.issues??[])issues.push({path:p,code:'js_reference_requires_review'});}
      else issues.push({path:p,code:'javascript_parser_not_supplied'});
      // Platform variants are all relevant: Metro selects at runtime/build time, not by alphabetical order.
      const stem=p.replace(/(?:\.(?:ios|android|native|web))?\.[cm]?[jt]sx?$/,'');
      const variants=[...files.keys()].filter(q=>q!==p&&q.replace(/(?:\.(?:ios|android|native|web))?\.[cm]?[jt]sx?$/,'')===stem);
      if(variants.length)edge(p,'platform-variants',variants);
      continue;
    }
    if(language==='dart') {const d=dartDirectives(file);for(const r of d.directives){const found=resolveDart(p,r.specifier,profile,files);edge(p,found.kind,found.targets,r.specifier);if(r.conditional)issues.push({path:p,code:'conditional_platform_directive'});}for(const code of d.issues)issues.push({path:p,code});continue;}
    const component=componentsForPath(profile,p)[0],root=component?.root??'',dir=path.posix.dirname(p);
    const {imports,issues:lexical}=importWords(file,language);for(const code of lexical)issues.push({path:p,code});
    if(language==='python') {
      for(const imp of imports.filter(x=>['from','import'].includes(x.kind))) {
        const stop=imp.tokens.findIndex(t=>t.value==='import');
        const names=imp.kind==='from'?imp.tokens.slice(0,stop<0?imp.tokens.length:stop):imp.tokens.slice(0,imp.tokens.findIndex(t=>t.value==='as')<0?undefined:imp.tokens.findIndex(t=>t.value==='as'));
        if(names.some(t=>t.value===','||t.value==='(')){issues.push({path:p,code:'complex_python_import'});continue;}
        const name=names.map(t=>t.value).join(''),relative=/^(\.+)(.*)$/.exec(name),tail=(relative?relative[2]:name).replaceAll('.','/');
        if(!/^[.A-Za-z_][.A-Za-z0-9_]*$/.test(name)){issues.push({path:p,code:'complex_python_import'});continue;}
        const bases=relative?[path.posix.normalize(path.posix.join(dir,...Array(Math.max(0,relative[1].length-1)).fill('..'),tail))]:[path.posix.join(root,tail),path.posix.join(root,'src',tail)];
        const paths=bases.flatMap(b=>[b+'.py',path.posix.join(b,'__init__.py')]);
        if(!relative&&!paths.some(q=>files.has(q)))edge(p,'external',[],name);else candidates(p,paths,name);
      }
      issues.push({path:p,code:'python_static_import_subset'});
    } else if(language==='go') {
      // Go files in one package can refer to sibling declarations without importing the sibling file.
      edge(p,'same-package',[...files.keys()].filter(q=>q!==p&&path.posix.dirname(q)===dir&&q.endsWith('.go')&&!q.endsWith('_test.go')));
      const goMod=files.get(path.posix.join(root,'go.mod'))?.content??'',module=/^module\s+(\S+)/m.exec(goMod)?.[1];
      const {tokens}=sourceTokens(file.content);
      for(let i=0;i<tokens.length;i++)if(tokens[i].value==='import'&&tokens[i].kind==='word') {
        let end=i+1;if(tokens[end]?.value==='('){while(end<tokens.length&&tokens[end].value!==')')end++;}else{while(end<tokens.length&&tokens[end].kind!=='string'&&!file.content.slice(tokens[i].end,tokens[end].start).includes('\n'))end++;}
        for(const token of tokens.slice(i+1,end+1).filter(t=>t.kind==='string'&&t.static)) {
          if(module&&token.value.startsWith(module+'/')){const targetDir=path.posix.join(root,token.value.slice(module.length+1));const targets=[...files.keys()].filter(q=>path.posix.dirname(q)===targetDir&&q.endsWith('.go')&&!q.endsWith('_test.go'));edge(p,targets.length?'package-files':'unresolved',targets,token.value);}else edge(p,'external',[],token.value);
        }
      }
      if(/(?:^|\n)\s*\/\/go:build|_(?:windows|linux|darwin|android|ios)\.go$/.test(file.content+'\n'+p))issues.push({path:p,code:'go_build_constraints_require_toolchain'});
    } else if(['kotlin','java','swift'].includes(language)) {
      for(const imp of imports.filter(x=>x.kind==='import'))edge(p,'module-reference',[],imp.tokens.filter(t=>t.kind==='word'||t.value==='.').map(t=>t.value).join(''));
      const target=language==='swift'?/^(.*?Sources\/[^/]+)\//.exec(p)?.[1]:null;
      const siblings=[...files.keys()].filter(q=>q!==p&&languageForPath(q)===language&&(target?insideRoot(q,target):path.posix.dirname(q)===dir));
      if(siblings.length)edge(p,'target-sibling-candidates',siblings);
      issues.push({path:p,code:'native_target_membership_requires_toolchain'});
    } else if(['c','cpp','objective-c','objective-c++'].includes(language)) {
      const {tokens}=sourceTokens(file.content);
      for(let i=0;i<tokens.length-2;i++)if(tokens[i].value==='#'&&['include','import'].includes(tokens[i+1].value)&&tokens[i+2].kind==='string'&&tokens[i+2].static){const spec=tokens[i+2].value;candidates(p,[path.posix.join(dir,spec),path.posix.join(root,'include',spec)],spec);}
      issues.push({path:p,code:'preprocessor_configuration_requires_toolchain'});
    } else if(language==='rust') {
      for(const imp of imports.filter(x=>x.kind==='mod')) {const name=imp.tokens[0]?.value;if(/^[A-Za-z_]\w*$/.test(name??''))candidates(p,[path.posix.join(dir,name+'.rs'),path.posix.join(dir,name,'mod.rs')],name);}
      issues.push({path:p,code:'rust_macro_and_cfg_resolution_not_performed'});
    } else issues.push({path:p,code:'dependency_adapter_not_implemented'});
  }
  return {profile,adjacency,edges,issues,complete:false,scope:'static-dependency-evidence'};
}
/** Follow inspected edges with a visited set, including cyclic libraries without looping. */
export function dependencyClosure(graph,roots) {
  const visited=new Set(roots),queue=[...roots];
  for(let i=0;i<queue.length;i++)for(const target of graph.adjacency.get(queue[i])??[])if(!visited.has(target)){visited.add(target);queue.push(target);}
  return [...visited].sort();
}
