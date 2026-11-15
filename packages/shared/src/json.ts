/** JSON-compatible value (what `JSON.stringify` round-trips and Postgres `jsonb` stores). */
export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MAX_DEPTH = 32;

/**
 * Converts decoded on-chain data (viem log args, receipts) into JSON: bigints become decimal strings,
 * 20-byte addresses become lowercase, `undefined` object members are dropped, everything else must
 * already be JSON. Throws on functions, symbols, non-finite numbers, class instances and cycles.
 */
export function toJsonValue(value: unknown): JsonValue {
  return convert(value, 0);
}

function convert(value: unknown, depth: number): JsonValue {
  if (depth > MAX_DEPTH) throw new TypeError('JSON value nested too deeply');
  if (value === null) return null;
  switch (typeof value) {
    case 'bigint':
      return value.toString();
    case 'string':
      return ADDRESS.test(value) ? value.toLowerCase() : value;
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`Non-finite number: ${value}`);
      return value;
    case 'object':
      return convertObject(value, depth);
    default:
      throw new TypeError(`Unsupported JSON value: ${typeof value}`);
  }
}

function convertObject(value: object, depth: number): JsonValue {
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    return items.map((item) => convert(item, depth + 1));
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Only plain objects can be converted to JSON');
  }
  const entries = Object.entries(value)
    .filter(([, member]) => member !== undefined)
    .map(([key, member]) => [key, convert(member, depth + 1)] as const);
  return Object.fromEntries(entries);
}

/** Reads a string member of a JSON object (e.g. an event argument), or `undefined`. */
export function jsonString(value: JsonValue | undefined, key: string): string | undefined {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const member = (value as { readonly [key: string]: JsonValue })[key];
  return typeof member === 'string' ? member : undefined;
}
