/**
 * @file Deterministic, non-executing project inventory for polyglot and mobile repositories.
 * Manifest evidence describes project shape, not a promise that a build or transfer works.
 * Never evaluate Gradle, Podfile, Package.swift, package scripts or repository configuration.
 */
import path from 'node:path';
import { eligiblePath } from './policy.mjs';
const EXTENSIONS = Object.freeze({
  js:'javascript', mjs:'javascript', cjs:'javascript', jsx:'javascript', ts:'typescript', mts:'typescript', cts:'typescript', tsx:'typescript',
  dart:'dart', swift:'swift', m:'objective-c', mm:'objective-c++', kt:'kotlin', kts:'kotlin', java:'java', py:'python', go:'go', rs:'rust',
  cs:'csharp', fs:'fsharp', fsx:'fsharp', c:'c', h:'c', cc:'cpp', cpp:'cpp', hpp:'cpp', rb:'ruby', php:'php', lua:'lua', r:'r', jl:'julia',
  ex:'elixir', exs:'elixir', erl:'erlang', hrl:'erlang', hs:'haskell', lhs:'haskell', scala:'scala', sc:'scala', clj:'clojure', cljs:'clojure',
  cljc:'clojure', elm:'elm', pl:'perl', pm:'perl', sh:'shell', bash:'shell', zsh:'shell', vue:'vue', svelte:'svelte', html:'html', css:'css', scss:'css', sql:'sql'
});
export const PROFILE_LIMITS = Object.freeze({ components: 32, dependencies: 100, evidence: 12 });
const MOBILE = new Set(['flutter','react-native','expo','android','apple-app','maui']);
/** Classify all admitted implementation extensions centrally, including markup and mobile languages. */
export function languageForPath(filePath) { return EXTENSIONS[path.posix.extname(filePath).slice(1).toLowerCase()] ?? null; }
/** Bound manifest names before exposing metadata; names are identifiers, never instructions or commands. */
const safeName = value => typeof value === 'string' && /^[A-Za-z0-9_@./-]{1,160}$/.test(value) ? value : null;
/** Test path heuristics are discovery hints, not test execution or full coverage analysis. */
export function isProjectTest(filePath) {
  return /(?:^|\/)(?:tests?|__tests__|spec|integration_test|androidTest)\//i.test(filePath) ||
    /(?:^|\/)(?:test_[^/]+\.py|[^/]+_test\.(?:py|go|dart)|[^/]+\.(?:test|spec)\.[cm]?[jt]sx?|[^/]+(?:Tests?|Spec)\.(?:swift|kt|java|cs))$/i.test(filePath);
}
/** Directory of a manifest in repository coordinates; the repository root is the empty string. */
const directory = filePath => path.posix.dirname(filePath) === '.' ? '' : path.posix.dirname(filePath);
/** Check path containment without treating a sibling with the same prefix as a child. */
export const insideRoot = (filePath, root) => !root || filePath.startsWith(root + '/');
/**
 * Read only plain block-style pubspec names/dependency keys. Complex YAML remains explicit uncertainty.
 * This intentionally does not resolve versions, overrides, workspaces, URLs, anchors or environment values.
 */
export function readPubspec(text) {
  let name = null, section = '', complex = false;
  const dependencies = new Set(), devDependencies = new Set(), sections = new Set(), keys = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '');
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (/\t|(?:^|\s)[&*!]|<<\s*:/.test(line)) complex = true;
    const top = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (top) {
      section = top[1];
      if (sections.has(section)) complex = true;
      sections.add(section);
      if (section === 'name') name = safeName(top[2].replace(/^(['"])(.*?)\1$/, '$2').trim());
      if (['dependencies','dev_dependencies','dependency_overrides','workspace'].includes(section) && top[2].trim()) complex = true;
      if (['dependency_overrides','workspace','resolution'].includes(section)) complex = true;
      continue;
    }
    const dependency = /^  ([a-z][a-z0-9_]*):(?:\s|$)/.exec(line);
    if (dependency && ['dependencies', 'dev_dependencies'].includes(section)) {
      const key = section + ':' + dependency[1];
      if (keys.has(key)) complex = true;
      keys.add(key);
    }
    if (dependency && section === 'dependencies') dependencies.add(dependency[1]);
    if (dependency && section === 'dev_dependencies') devDependencies.add(dependency[1]);
  }
  if (!name || !/^[a-z][a-z0-9_]*$/.test(name)) { name = null; complex = true; }
  return { name, dependencies: [...dependencies].sort(), devDependencies: [...devDependencies].sort(), complete: !complex };
}
/**
 * Inventory manifests across a monorepo. Path-only markers are labeled unread; malformed manifests
 * never trigger invented dependencies. Output size and ordering are deterministic and bounded.
 */
export function profileProject(repo) {
  const files = new Map((repo.files ?? []).filter(f => eligiblePath(f.path)).map(f => [f.path, f]));
  const inventory = [...new Set([...(repo.inventory ?? []), ...files.keys()])].filter(eligiblePath).sort();
  const components = new Map(), warnings = new Set();
  /** Record one component from a concrete manifest marker; preserve mixed platforms at the same root. */
  function add(root, kind, marker, extra = {}) {
    const key = root + ':' + kind;
    const prior = components.get(key);
    if (prior) { if (!prior.evidence.includes(marker)) prior.evidence.push(marker); return; }
    components.set(key, { root, kind, manifest: marker, evidence: [marker], evidenceRead: files.has(marker), ...extra });
  }
  for (const p of inventory) {
    const name = path.posix.basename(p), root = directory(p), text = files.get(p)?.content;
    if (name === 'package.json') {
      let pkg;
      try { pkg = text === undefined ? null : JSON.parse(text); } catch { warnings.add('malformed_manifest:' + p); }
      if (pkg && (typeof pkg !== 'object' || Array.isArray(pkg))) { warnings.add('malformed_manifest:' + p); pkg = null; }
      const deps = [...new Set([pkg?.dependencies, pkg?.devDependencies, pkg?.peerDependencies].flatMap(d => d && typeof d === 'object' && !Array.isArray(d) ? Object.keys(d).filter(safeName) : []))].sort();
      const kind = deps.includes('expo') ? 'expo' : deps.includes('react-native') ? 'react-native' : deps.some(d => ['next','react','vue','svelte','@angular/core'].includes(d)) ? 'web' : 'node';
      add(root, kind, p, { name: safeName(pkg?.name), dependencies: deps.slice(0, PROFILE_LIMITS.dependencies), dependencyCount: deps.length });
    } else if (name === 'pubspec.yaml') {
      const spec = text === undefined ? { name:null, dependencies:[], devDependencies:[], complete:false } : readPubspec(text);
      const deps = [...new Set([...spec.dependencies, ...spec.devDependencies])].sort();
      if (!spec.complete) warnings.add('pubspec_requires_toolchain_resolution:' + p);
      add(root, deps.includes('flutter') ? 'flutter' : 'dart', p, { name:spec.name, dependencies:deps.slice(0, PROFILE_LIMITS.dependencies), dependencyCount:deps.length, pubspecComplete:spec.complete });
    } else if (/^build\.gradle(?:\.kts)?$/.test(name)) {
      add(root, /com\.android\.(?:application|library)|android\s*\{/.test(text ?? '') || inventory.includes((root ? root + '/' : '') + 'src/main/AndroidManifest.xml') ? 'android' : 'jvm', p);
    } else if (name === 'Package.swift') add(root, 'swift-package', p);
    else if (/\.xcodeproj\/project\.pbxproj$/.test(p)) add(directory(root), 'apple-app', p);
    else if (/\.(?:csproj|fsproj)$/.test(name)) add(root, /<UseMaui>\s*true\s*<\/UseMaui>/.test(text ?? '') ? 'maui' : 'dotnet', p);
    else if (['pyproject.toml','setup.py','requirements.txt'].includes(name)) add(root, 'python', p);
    else if (name === 'go.mod') add(root, 'go', p);
    else if (name === 'Cargo.toml') add(root, 'rust', p);
    else if (name === 'pom.xml') add(root, 'jvm', p);
    else if (name === 'Gemfile') add(root, 'ruby', p);
    else if (name === 'composer.json') add(root, 'php', p);
    else if (name === 'CMakeLists.txt') add(root, 'cmake', p);
  }
  const languages = [...new Set(inventory.map(languageForPath).filter(Boolean))].sort();
  if (!components.size) components.set(':source-only', { root:'', kind:'source-only', manifest:null, evidence:[], evidenceRead:false });
  const all = [...components.values()].sort((a,b) => (a.root + ':' + a.kind).localeCompare(b.root + ':' + b.kind));
  const bounded = all.slice(0, PROFILE_LIMITS.components).map(c => ({ ...c,
    evidence:c.evidence.sort().slice(0, PROFILE_LIMITS.evidence), mobile:MOBILE.has(c.kind),
    languages:[...new Set(inventory.filter(p => insideRoot(p,c.root) && !all.some(other => other.root !== c.root && insideRoot(other.root,c.root) && insideRoot(p,other.root))).map(languageForPath).filter(Boolean))].sort(),
    detection:c.manifest ? 'manifest-evidence' : 'source-only', verification:'not_run'
  }));
  if (all.length > PROFILE_LIMITS.components) warnings.add('component_inventory_truncated');
  return { version:1, languages, components:bounded, omittedComponents:Math.max(0,all.length-bounded.length), warnings:[...warnings].sort(),
    scope:'static-manifest-inspection', notice:'Project detection is not semantic compatibility or a successful build. Binary assets, toolchain resolution and device behavior require separate checks.' };
}
/** Find the nearest recorded component root; retain multiple ecosystems at that root rather than guessing one. */
export function componentsForPath(profile, filePath) {
  const matches = profile.components.filter(c => insideRoot(filePath, c.root));
  const depth = Math.max(-1, ...matches.map(c => c.root.length));
  return matches.filter(c => c.root.length === depth);
}
