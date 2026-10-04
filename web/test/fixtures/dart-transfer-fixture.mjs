/** @file Authored multi-file mobile test fixture. No downloaded code, provider generation or fake execution metrics. */
import {snapshot} from '../../lib/core-base.mjs';

/** Build one Flutter/Dart package pair with renamed libraries, helper imports and unrelated destination content. */
export function dartFixture({flutter=true,sourceRoot='',destinationRoot='',collision=false}={}) {
  const s=p=>sourceRoot?sourceRoot+'/'+p:p,d=p=>destinationRoot?destinationRoot+'/'+p:p;
  const manifest=name=>`name: ${name}\nenvironment:\n  sdk: '>=3.4.0 <4.0.0'\n${flutter?'dependencies:\n  flutter:\n    sdk: flutter\n':''}dev_dependencies:\n  ${flutter?'flutter_test:\n    sdk: flutter':'test: ^1.25.0'}\n`;
  const runner=flutter?'flutter_test/flutter_test.dart':'test/test.dart';
  const source=snapshot({name:'example/source',revision:'a'.repeat(40),files:[
    {path:s('pubspec.yaml'),content:manifest('donor')},
    {path:s('lib/cart.dart'),content:"import 'price.dart';\nint cartTotal(int units) => priceFor(units);\n"},
    {path:s('lib/price.dart'),content:'int priceFor(int units) => units * 12;\n'},
    {path:s('test/cart_test.dart'),content:`// Preserve assertions, comments, Unicode π, and line endings.\nimport 'package:${runner}';\nimport 'support/cart_helper.dart';\nvoid main() {\n  test('cart total', () { expect(readCart(2), equals(24)); });\n}\n`},
    {path:s('test/support/cart_helper.dart'),content:"import 'package:donor/cart.dart' as cart;\nint readCart(int units) => cart.cartTotal(units);\n"},
    {path:s('test/price_test.dart'),content:`import 'package:${runner}';\nimport '../lib/price.dart';\nvoid main() {\n  test('price is additive', () { expect(priceFor(3), 36); });\n}\n`},
    {path:s('test/unrelated_test.dart'),content:`import 'package:${runner}';\nvoid main() { test('unrelated', () { expect(1, 1); }); }\n`}
  ]});
  const destination=snapshot({name:'example/destination',revision:'b'.repeat(40),files:[
    {path:d('pubspec.yaml'),content:manifest('store')},
    {path:d('lib/main.dart'),content:'// Existing app entry stays untouched.\nvoid main() {}\n'},
    {path:d('README.md'),content:'UNRELATED_DESTINATION_SENTINEL\n'},
    ...(collision?[{path:d('test/cart_test.dart'),content:`// Existing user test must never be overwritten.\nimport 'package:${runner}';\nvoid main() { test('existing destination test', () { expect(true, isTrue); }); }\n`}]:[])
  ]});
  const proposal={summary:'Move the cart pricing feature',changes:[
    {path:d('lib/features/basket.dart'),action:'add',content:"import 'price.dart';\nint cartTotal(int units) => priceFor(units);\n",reason:'Adapt cart to the destination library.',sourcePaths:[s('lib/cart.dart')]},
    {path:d('lib/features/price.dart'),action:'add',content:'int priceFor(int units) => units * 12;\n',reason:'Preserve pricing dependency.',sourcePaths:[s('lib/price.dart')]}
  ],risks:[],suggestedChecks:[flutter?'flutter analyze && flutter test':'dart analyze && dart test']};
  const roots=[s('lib/cart.dart')],landing=[d('lib/main.dart')];
  const context={feature:'cart pricing',source:source.files,destination:destination.files,selection:{sourcePaths:roots,destinationPaths:landing}};
  return {source,destination,proposal,context,roots,landing,s,d};
}
