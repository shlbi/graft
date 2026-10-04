/** @file Executable Dart-header/URI regressions; parses authored text, never evaluates Dart or contacts a provider. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {dartDirectives,resolveDart,sourceGraph,dependencyClosure} from '../lib/source-graph.mjs';
import {profileProject,readPubspec} from '../lib/project-profile.mjs';

/** Create exact test-only file inventories. */
const repo = entries => ({files:Object.entries(entries).map(([path,content])=>({path,content})),inventory:Object.keys(entries)});
/** Extract URI text and ensure every proposed edit span matches source bytes. */
function parsed(text) {
  const value=dartDirectives({path:'test/example_test.dart',content:text});
  for(const r of value.directives)assert.equal(text.slice(r.start,r.end),r.specifier);
  return value;
}

test('conditional comparison strings are not treated as library URIs',()=>{
  const d=parsed(`import 'stub.dart' if (dart.library.io == 'true') 'io.dart';`);
  assert.deepEqual(d.directives.map(r=>r.specifier),['stub.dart','io.dart']);assert.deepEqual(d.issues,[]);
});
test('multiple conditional branches retain all actual libraries',()=>{
  const d=parsed(`export 'stub.dart' if (dart.library.io) 'io.dart' if (dart.library.js_interop) "web.dart" show Counter, Total;`);
  assert.deepEqual(d.directives.map(r=>r.specifier),['stub.dart','io.dart','web.dart']);assert.ok(d.directives.every(r=>r.conditional));assert.deepEqual(d.issues,[]);
});
test('metadata and comments cannot fabricate imports or terminate a directive',()=>{
  const d=parsed(`/* outer /* import 'bad.dart'; */ */\n@TestOn('vm')\n@Tags([';', '{', 'import "bad.dart";'])\nlibrary;\nimport 'good.dart' as good;\nvoid main() { print("import 'fake.dart';"); }`);
  assert.deepEqual(d.directives.map(r=>r.specifier),['good.dart']);assert.deepEqual(d.issues,[]);
});
test('quoted punctuation is content, not syntax',()=>{
  const d=parsed(`import ';'; import '{'; import 'good.dart';`);
  assert.deepEqual(d.directives.map(r=>r.specifier),[';','{','good.dart']);assert.deepEqual(d.issues,[]);
});
test('aliases, deferred imports, library names and combinators stay verbatim',()=>{
  const d=parsed(`library source.example;\nimport r'counter.dart' deferred as c show Counter, Total hide Internal;\nexport 'api.dart' show Counter;`);
  assert.deepEqual(d.directives.map(r=>r.specifier),['counter.dart','api.dart']);assert.deepEqual(d.issues,[]);
});
for(const text of [`import 'a.dart' if dart.library.io 'b.dart';`,`import 'a.dart' as;`,`import 'a.dart' show;`,`import 'a.dart' unsupported;`,`import 'a.dart'`,`import 'a\n.dart';`,`import 'a${'${name}'}.dart';`,`import '''a.dart''';`]) {
  test('unsupported header is explicit: '+JSON.stringify(text),()=>assert.ok(parsed(text).issues.length));
}
test('part libraries explicitly require another adapter',()=>{
  assert.ok(parsed(`part 'counter.g.dart';`).issues.includes('part_requires_library_adapter'));
  assert.ok(parsed(`part of 'counter.dart';`).issues.includes('part_of_requires_library_context'));
});
test('Dart imports cannot resolve into a nested sibling package by relative path',()=>{
  const r=repo({'pubspec.yaml':'name: root_app\n','lib/main.dart':'','modules/cart/pubspec.yaml':'name: cart\n','modules/cart/lib/cart.dart':''});
  const p=profileProject(r),files=new Map(r.files.map(f=>[f.path,f]));
  assert.equal(resolveDart('lib/main.dart','../modules/cart/lib/cart.dart',p,files).kind,'unresolved');
  assert.equal(resolveDart('modules/cart/lib/cart.dart','../../../lib/main.dart',p,files).kind,'unresolved');
});
test('valid local, parent-directory and self-package URIs resolve within a package',()=>{
  const r=repo({'pubspec.yaml':'name: shop\n','lib/cart.dart':'','test/cart_test.dart':''}),p=profileProject(r),files=new Map(r.files.map(f=>[f.path,f]));
  for(const uri of ['../lib/cart.dart','package:shop/cart.dart'])assert.deepEqual(resolveDart('test/cart_test.dart',uri,p,files).targets,['lib/cart.dart']);
  assert.equal(resolveDart('lib/cart.dart','dart:async',p,files).kind,'builtin');
  assert.equal(resolveDart('lib/cart.dart','package:collection/collection.dart',p,files).kind,'external');
});
for(const uri of ['https://evil.test/a.dart','package:foo/../a.dart','package:foo/a.dart?x=1','package:foo/a%2fdart','/tmp/a.dart','C:\\a.dart','dart:io?x','package:foo//a.dart']) {
  test('invalid URI cannot become a rewrite target: '+uri,()=>{
    const r=repo({'pubspec.yaml':'name: shop\n','lib/cart.dart':''}),p=profileProject(r);
    assert.equal(resolveDart('lib/cart.dart',uri,p,new Map(r.files.map(f=>[f.path,f]))).kind,'unresolved');
  });
}
test('duplicate package names/sections/keys do not count as unambiguous pubspec parsing',()=>{
  for(const text of ['name: a\nname: b\n','name: a\ndependencies:\n  http: any\ndependencies:\n  test: any\n','name: a\ndev_dependencies:\n  test: any\n  test: ^1.0.0\n'])assert.equal(readPubspec(text).complete,false);
  assert.equal(readPubspec('name: a\ndependencies:\n  http: any\ndev_dependencies:\n  test: any\n').complete,true);
});
test('the public graph includes only real conditional dependencies and handles cycles',()=>{
  const r=repo({'pubspec.yaml':'name: a\n','lib/a.dart':`import 'stub.dart' if (dart.library.io == 'true') 'io.dart';`,'lib/stub.dart':`import 'a.dart';`,'lib/io.dart':''});
  const g=sourceGraph(r);assert.deepEqual(dependencyClosure(g,['lib/a.dart']),['lib/a.dart','lib/io.dart','lib/stub.dart']);
  assert.ok(!g.edges.some(e=>e.specifier==='true'));assert.ok(g.issues.some(i=>i.code==='conditional_platform_directive'));
});
