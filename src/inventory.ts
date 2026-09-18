import type { CapabilityKind } from './manifest.js';
import { projectPath } from './manifest.js';
import type { DestinationCapability } from './planner.js';

export interface DestinationInventory {
  schemaVersion: 1;
  capabilities: DestinationCapability[];
}

export class InventoryError extends Error {
  constructor(public readonly field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = 'InventoryError';
  }
}

type JsonObject = Record<string, unknown>;

function object(value: unknown, field: string, allowed: readonly string[]): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InventoryError(field, 'expected an object');
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new InventoryError(`${field}.${key}`, 'unknown field');
  }
  return value as JsonObject;
}

function text(value: unknown, field: string, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new InventoryError(field, `expected a nonempty string of at most ${max} characters`);
  }
  return value;
}

function kind(value: unknown, field: string): CapabilityKind {
  const supported: CapabilityKind[] = ['storage', 'jobs', 'database', 'auth', 'events'];
  if (typeof value !== 'string' || !supported.includes(value as CapabilityKind)) {
    throw new InventoryError(field, `expected one of: ${supported.join(', ')}`);
  }
  return value as CapabilityKind;
}

/**
 * Parses an explicit destination capability inventory. Discovery remains
 * conservative: Graft only maps capabilities the destination declares here.
 */
export function parseDestinationInventory(input: unknown): DestinationInventory {
  const root = object(input, 'inventory', ['schemaVersion', 'capabilities']);
  if (root.schemaVersion !== 1) {
    throw new InventoryError('schemaVersion', 'only version 1 is supported');
  }
  if (!Array.isArray(root.capabilities) || root.capabilities.length > 128) {
    throw new InventoryError('capabilities', 'expected an array with at most 128 items');
  }

  const seen = new Set<string>();
  const capabilities = root.capabilities.map((item, index) => {
    const field = `capabilities[${index}]`;
    const raw = object(item, field, ['name', 'kind', 'contract', 'module']);
    const name = text(raw.name, `${field}.name`, 64);
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(name)) {
      throw new InventoryError(`${field}.name`, 'expected a lowercase capability slug');
    }
    if (seen.has(name)) throw new InventoryError('capabilities.name', `duplicate capability: ${name}`);
    seen.add(name);

    const contract = text(raw.contract, `${field}.contract`);
    if (!/^[a-z][a-z0-9._-]*(?:\.[a-z0-9._-]+)*$/iu.test(contract)) {
      throw new InventoryError(`${field}.contract`, 'expected a versionable identifier such as graft.storage.v1');
    }

    return {
      name,
      kind: kind(raw.kind, `${field}.kind`),
      contract,
      module: projectPath(raw.module, `${field}.module`),
    };
  });

  capabilities.sort((a, b) => a.name.localeCompare(b.name));
  return { schemaVersion: 1, capabilities };
}
