/** Versioned, explicit boundaries for the supported Graft feature subset. */
export type Role = 'frontend' | 'backend' | 'shared';
export type CapabilityKind = 'storage' | 'jobs' | 'database' | 'auth' | 'events';
export interface FeatureManifest {
  schemaVersion: 1;
  name: string;
  entrypoints: { path: string; role: Role }[];
  capabilities: { name: string; kind: CapabilityKind; contract: string; module: string }[];
  assets: { path: string; kind: 'schema' | 'config' | 'static' }[];
  environment: string[];
}
export class ManifestError extends Error {
  constructor(public readonly field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = 'ManifestError';
  }
}
type RecordValue = Record<string, unknown>;
function record(value: unknown, field: string, allowed: string[]): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ManifestError(field, 'expected an object');
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new ManifestError(`${field}.${key}`, 'unknown field');
  return value as RecordValue;
}
function textValue(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) throw new ManifestError(field, 'expected a nonempty string of at most 512 characters');
  return value;
}
function choice<T extends string>(value: unknown, field: string, choices: readonly T[]): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) throw new ManifestError(field, `expected one of: ${choices.join(', ')}`);
  return value as T;
}
function list(value: unknown, field: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new ManifestError(field, `expected an array with at most ${max} items`);
  return value;
}
function unique(values: string[], field: string): void {
  if (new Set(values).size !== values.length) throw new ManifestError(field, 'duplicate values');
}
/** Lexical check only: filesystem callers must also enforce realpath containment. */
export function projectPath(value: unknown, field = 'path'): string {
  const result = textValue(value, field);
  const parts = result.split('/');
  if (result.startsWith('/') || /[\\:\x00-\x1f\x7f]/u.test(result) || parts.some(part => !part || part === '.' || part === '..')) {
    throw new ManifestError(field, 'expected a normalized project-relative POSIX path');
  }
  if (parts.some(part => part === '.git' || part === 'node_modules' || /^\.env(?:\.|$)/u.test(part) || /\.(?:pem|key|p12|pfx)$/iu.test(part))) {
    throw new ManifestError(field, 'repository internals, dependencies, and secret files are excluded');
  }
  return result;
}
export function parseFeatureManifest(input: unknown): FeatureManifest {
  const root = record(input, 'manifest', ['schemaVersion','name','entrypoints','capabilities','assets','environment']);
  if (root.schemaVersion !== 1) throw new ManifestError('schemaVersion', 'only version 1 is supported');
  const name = textValue(root.name, 'name');
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(name)) throw new ManifestError('name', 'expected a lowercase feature slug');
  const entrypoints = list(root.entrypoints, 'entrypoints', 128).map((item, i) => {
    const field = `entrypoints[${i}]`; const entry = record(item, field, ['path','role']);
    return { path: projectPath(entry.path, `${field}.path`), role: choice(entry.role, `${field}.role`, ['frontend','backend','shared'] as const) };
  });
  if (!entrypoints.length) throw new ManifestError('entrypoints', 'at least one entrypoint is required');
  unique(entrypoints.map(entry => entry.path), 'entrypoints');
  const capabilities = list(root.capabilities, 'capabilities', 64).map((item, i) => {
    const field = `capabilities[${i}]`; const capability = record(item, field, ['name','kind','contract','module']);
    const capabilityName = textValue(capability.name, `${field}.name`);
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(capabilityName)) throw new ManifestError(`${field}.name`, 'expected a lowercase capability slug');
    return { name: capabilityName, kind: choice(capability.kind, `${field}.kind`, ['storage','jobs','database','auth','events'] as const), contract: textValue(capability.contract, `${field}.contract`), module: projectPath(capability.module, `${field}.module`) };
  });
  unique(capabilities.map(capability => capability.name), 'capabilities.name');
  const assets = list(root.assets, 'assets', 256).map((item, i) => {
    const field = `assets[${i}]`; const asset = record(item, field, ['path','kind']);
    return { path: projectPath(asset.path, `${field}.path`), kind: choice(asset.kind, `${field}.kind`, ['schema','config','static'] as const) };
  });
  unique(assets.map(asset => asset.path), 'assets');
  const environment = list(root.environment, 'environment', 128).map((item, i) => {
    const value = textValue(item, `environment[${i}]`);
    if (!/^[A-Z_][A-Z0-9_]*$/u.test(value)) throw new ManifestError(`environment[${i}]`, 'use a variable name, never its value');
    return value;
  });
  unique(environment, 'environment');
  return { schemaVersion: 1, name, entrypoints, capabilities, assets, environment };
}
