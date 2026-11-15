import { keccak256, stringToBytes, type Hex } from 'viem';

/**
 * Canonical JSON (RFC 8785 style): object keys sorted by UTF-16 code units, no whitespace,
 * ECMAScript number/string serialization. Used for `keccak256(canonicalJSON(output))` agent
 * signatures and the batch `resultsHash`, so every package must hash identical bytes.
 * Rejects bigint, non-finite numbers, functions, symbols, non-plain objects and cycles;
 * object properties whose value is `undefined` are omitted (JSON semantics).
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, new Set());
}

export function hashCanonicalJson(value: unknown): Hex {
  return keccak256(stringToBytes(canonicalJson(value)));
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function serialize(value: unknown, ancestors: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value))
        throw new TypeError(`Non-finite number in canonical JSON: ${value}`);
      return JSON.stringify(value);
    case 'object':
      return serializeObject(value, ancestors);
    default:
      throw new TypeError(`Unsupported value in canonical JSON: ${typeof value}`);
  }
}

function serializeObject(value: object, ancestors: Set<object>): string {
  if (ancestors.has(value)) throw new TypeError('Circular reference in canonical JSON');
  const nextAncestors = new Set(ancestors).add(value);
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    return `[${items.map((item) => serialize(item, nextAncestors)).join(',')}]`;
  }
  if (!isPlainObject(value))
    throw new TypeError('Only plain objects are allowed in canonical JSON');
  const members = Object.keys(value)
    .sort()
    .filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${serialize(value[key], nextAncestors)}`);
  return `{${members.join(',')}}`;
}
