/**
 * Authored Flutter widget/host inputs, never downloaded customer code or AI output.
 * Raw descriptors become real snapshots in the materializer/core tests. All test
 * bodies below predate relocation and remain unchanged outside import URI spans.
 */
export const WIDGET_TEST_NAMES = Object.freeze([
  'widget: renders initial quantity and price',
  'widget: buttons update price and preserve entered text',
  'widget: quantity cannot go below one',
  'widget: disposes its controller and resets on remount',
]);
export const PRICE_TEST_NAME = 'pricing: uses the production pricing dependency';
export const EXISTING_TEST_NAMES = Object.freeze([
  'existing: store home remains available',
  'existing: catalog route still works',
]);
export const HOST_TEST_NAMES = Object.freeze([
  'host: cart route renders and updates pricing',
  'host: route exit and reentry resets state',
]);
export const UNRELATED_TEST_NAME = 'unrelated: donor sentinel';

const widgetSource = `import 'package:flutter/material.dart';
import 'price.dart';

class CartPanel extends StatefulWidget {
  const CartPanel({super.key});
  @override
  State<CartPanel> createState() => _CartPanelState();
}

class _CartPanelState extends State<CartPanel> {
  int units = 1;
  final noteController = TextEditingController();

  @override
  void dispose() {
    noteController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Cart')),
      body: Column(children: [
        Text('Units: $units'),
        Text('Total: \${priceFor(units)}'),
        TextField(key: const Key('cart-note'), controller: noteController),
        Row(children: [
          ElevatedButton(
            key: const Key('cart-remove'),
            onPressed: units > 1 ? () => setState(() { units -= 1; }) : null,
            child: const Text('Remove'),
          ),
          ElevatedButton(
            key: const Key('cart-add'),
            onPressed: () => setState(() { units += 1; }),
            child: const Text('Add'),
          ),
        ]),
      ]),
    );
  }
}
`;

const widgetTests = `// Assertions, Unicode π, helper usage, and controller checks must survive relocation.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'support/widget_host.dart';

void main() {
  testWidgets('${WIDGET_TEST_NAMES[0]}', (tester) async {
    await tester.pumpWidget(cartHarness());
    expect(find.text('Cart'), findsOneWidget);
    expect(find.text('Units: 1'), findsOneWidget);
    expect(find.text('Total: 12'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('${WIDGET_TEST_NAMES[1]}', (tester) async {
    await tester.pumpWidget(cartHarness());
    await tester.enterText(find.byKey(const Key('cart-note')), 'Keep this note');
    await tester.tap(find.byKey(const Key('cart-add')));
    await tester.pump();
    expect(find.text('Units: 2'), findsOneWidget);
    expect(find.text('Total: 24'), findsOneWidget);
    expect(find.text('Keep this note'), findsOneWidget);
    await tester.tap(find.byKey(const Key('cart-remove')));
    await tester.pump();
    expect(find.text('Total: 12'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('${WIDGET_TEST_NAMES[2]}', (tester) async {
    await tester.pumpWidget(cartHarness());
    final button = tester.widget<ElevatedButton>(find.byKey(const Key('cart-remove')));
    expect(button.onPressed, isNull);
    await tester.tap(find.byKey(const Key('cart-remove')));
    await tester.pump();
    expect(find.text('Units: 1'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('${WIDGET_TEST_NAMES[3]}', (tester) async {
    await tester.pumpWidget(cartHarness());
    final controller = tester.widget<TextField>(find.byKey(const Key('cart-note'))).controller!;
    await tester.enterText(find.byKey(const Key('cart-note')), 'Temporary');
    await tester.pumpWidget(const SizedBox.shrink());
    expect(() => controller.addListener(() {}), throwsFlutterError);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(cartHarness());
    expect(find.text('Units: 1'), findsOneWidget);
    expect(find.text('Temporary'), findsNothing);
    expect(tester.takeException(), isNull);
  });
}
`;

function storeMain(installed) {
  return `import 'package:flutter/material.dart';
${installed ? "import 'features/cart_panel.dart';\n" : ''}
void main() => runApp(const StoreApp());
Widget cartPage() => ${installed ? "const CartPanel()" : "const Scaffold(body: Center(child: Text('Cart not installed')))"};

class StoreApp extends StatelessWidget {
  const StoreApp({super.key});
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      home: const StoreHome(),
      routes: {
        '/cart': (_) => cartPage(),
        '/catalog': (_) => Scaffold(
          appBar: AppBar(title: const Text('Catalog')),
          body: const Center(child: Text('Existing catalog')),
        ),
      },
    );
  }
}

class StoreHome extends StatelessWidget {
  const StoreHome({super.key});
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Store home')),
      body: Column(children: [
        ElevatedButton(
          key: const Key('open-cart'),
          onPressed: () => Navigator.of(context).pushNamed('/cart'),
          child: const Text('Open cart'),
        ),
        ElevatedButton(
          key: const Key('open-catalog'),
          onPressed: () => Navigator.of(context).pushNamed('/catalog'),
          child: const Text('Open catalog'),
        ),
      ]),
    );
  }
}
`;
}

const existingTests = `// Existing destination tests are not rewritten by this transfer.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:store_widgets/main.dart';

void main() {
  testWidgets('${EXISTING_TEST_NAMES[0]}', (tester) async {
    await tester.pumpWidget(const StoreApp());
    expect(find.text('Store home'), findsOneWidget);
    expect(find.byKey(const Key('open-cart')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
  testWidgets('${EXISTING_TEST_NAMES[1]}', (tester) async {
    await tester.pumpWidget(const StoreApp());
    await tester.tap(find.byKey(const Key('open-catalog')));
    await tester.pumpAndSettle();
    expect(find.text('Existing catalog'), findsOneWidget);
    await tester.pageBack();
    await tester.pumpAndSettle();
    expect(find.text('Store home'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
`;

/** Independent authored host probes are acceptance-only, never a model-authored patch addition. */
export const hostProbe = `import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:store_widgets/main.dart';

void main() {
  testWidgets('${HOST_TEST_NAMES[0]}', (tester) async {
    await tester.pumpWidget(const StoreApp());
    await tester.tap(find.byKey(const Key('open-cart')));
    await tester.pumpAndSettle();
    expect(find.text('Cart'), findsOneWidget);
    expect(find.text('Total: 12'), findsOneWidget);
    await tester.tap(find.byKey(const Key('cart-add')));
    await tester.pump();
    expect(find.text('Total: 24'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
  testWidgets('${HOST_TEST_NAMES[1]}', (tester) async {
    await tester.pumpWidget(const StoreApp());
    await tester.tap(find.byKey(const Key('open-cart')));
    await tester.pumpAndSettle();
    expect(find.text('Cart'), findsOneWidget);
    await tester.enterText(find.byKey(const Key('cart-note')), 'Transient route state');
    await tester.tap(find.byKey(const Key('cart-add')));
    await tester.pump();
    expect(find.text('Units: 2'), findsOneWidget);
    await tester.pageBack();
    await tester.pumpAndSettle();
    expect(find.text('Store home'), findsOneWidget);
    await tester.tap(find.byKey(const Key('open-cart')));
    await tester.pumpAndSettle();
    expect(find.text('Units: 1'), findsOneWidget);
    expect(find.text('Transient route state'), findsNothing);
    expect(tester.takeException(), isNull);
  });
}
`;

/** Root controls exercise different monorepo package locations without crossing package ownership. */
export function flutterWidgetFixture({sourceRoot = '', destinationRoot = ''} = {}) {
  for (const root of [sourceRoot, destinationRoot]) {
    if (typeof root !== 'string' || root && !/^[a-z][a-z0-9_-]*(\/[a-z][a-z0-9_-]*)*$/.test(root)) throw new TypeError('Invalid authored package root.');
  }
  const s = p => sourceRoot ? sourceRoot + '/' + p : p;
  const d = p => destinationRoot ? destinationRoot + '/' + p : p;
  const manifest = name => `name: ${name}\nenvironment:\n  sdk: '>=3.4.0 <4.0.0'\ndependencies:\n  flutter:\n    sdk: flutter\ndev_dependencies:\n  flutter_test:\n    sdk: flutter\n`;
  const sourceInput = {name: 'authored/widget-donor', revision: 'a'.repeat(40), files: [
    {path: s('pubspec.yaml'), content: manifest('donor_widgets')},
    {path: s('lib/cart_panel.dart'), content: widgetSource},
    {path: s('lib/price.dart'), content: 'int priceFor(int units) => units * 12;\n'},
    {path: s('test/cart_panel_test.dart'), content: widgetTests},
    {path: s('test/support/widget_host.dart'), content: "import 'package:flutter/material.dart';\nimport 'package:donor_widgets/cart_panel.dart';\nWidget cartHarness() => const MaterialApp(home: CartPanel());\n"},
    {path: s('test/price_test.dart'), content: `import 'package:flutter_test/flutter_test.dart';\nimport '../lib/price.dart';\nvoid main() { test('${PRICE_TEST_NAME}', () { expect(priceFor(3), 36); }); }\n`},
    {path: s('test/unrelated_test.dart'), content: `import 'package:flutter_test/flutter_test.dart';\nvoid main() { test('${UNRELATED_TEST_NAME}', () { expect(1, 1); }); }\n`},
  ]};
  const destinationInput = {name: 'authored/widget-store', revision: 'b'.repeat(40), files: [
    {path: d('pubspec.yaml'), content: manifest('store_widgets')},
    {path: d('lib/main.dart'), content: storeMain(false)},
    {path: d('test/cart_panel_test.dart'), content: existingTests},
    {path: d('README.md'), content: 'EXISTING_WIDGET_STORE_SENTINEL\n'},
  ]};
  const proposal = {summary: 'Integrate a stateful cart widget into the existing store route', changes: [
    {path: d('lib/features/cart_panel.dart'), action: 'add', content: widgetSource, reason: 'Move the widget and its lifecycle into the destination features directory.', sourcePaths: [s('lib/cart_panel.dart')]},
    {path: d('lib/features/price.dart'), action: 'add', content: 'int priceFor(int units) => units * 12;\n', reason: 'Carry the actual production pricing dependency.', sourcePaths: [s('lib/price.dart')]},
    {path: d('lib/main.dart'), action: 'update', content: storeMain(true), reason: 'Replace the empty cart route while preserving home and catalog.', sourcePaths: [s('lib/cart_panel.dart')]},
  ], risks: [], suggestedChecks: ['flutter analyze', 'flutter test --machine']};
  return {sourceInput, destinationInput, proposal, selection: {sourcePaths: [s('lib/cart_panel.dart')], destinationPaths: [d('lib/main.dart')]}, s, d};
}
