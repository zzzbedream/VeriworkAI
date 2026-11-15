import {
  normalizeRoot,
  toLowerAddress,
  UINT256_MAX,
  type Address,
  type Hex,
} from '@veriwork/shared';
import { Prisma } from './generated/prisma/client';

/** Exact Decimal(78, 0) -> bigint (via the decimal string, never through Number). */
export function toWei(value: Prisma.Decimal): bigint {
  if (!value.isInteger() || value.isNegative()) {
    throw new RangeError(`Not a non-negative integer wei amount: ${value.toFixed()}`);
  }
  return BigInt(value.toFixed(0));
}

export function toWeiOrNull(value: Prisma.Decimal | null): bigint | null {
  return value === null ? null : toWei(value);
}

/** bigint -> exact decimal string for a Decimal(78, 0) column (uint256 range enforced). */
export function weiInput(value: bigint): string {
  if (value < 0n || value > UINT256_MAX)
    throw new RangeError(`Wei amount out of uint256 range: ${value}`);
  return value.toString();
}

/** Parses an exact integer string returned by SQL (`SUM(...)::text`); NULL (empty set) is 0. */
export function weiFromText(value: string | null): bigint {
  if (value === null) return 0n;
  if (!/^-?\d+$/.test(value)) throw new RangeError(`Not an integer amount: ${value}`);
  return BigInt(value);
}

/** Lowercase address (addresses are always stored lowercase). */
export function lower(value: string): Address {
  return toLowerAddress(value);
}

export function lowerOrNull(value: string | null | undefined): Address | null {
  return value === null || value === undefined ? null : toLowerAddress(value);
}

/**
 * Lowercase GoodID root. Roots are the unique-human key, so the zero address ("no root", what
 * `getWhitelistedRoot` returns for unverified accounts) is refused instead of becoming a shared key.
 */
export function lowerRoot(value: string): Address {
  const root = normalizeRoot(value);
  if (root === null) throw new TypeError('A GoodID root cannot be the zero address');
  return root;
}

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

/** Lowercase 32-byte hex (on-chain ids, tx hashes, merkle roots). */
export function bytes32(value: string, label = 'value'): Hex {
  if (!BYTES32.test(value)) throw new TypeError(`${label} must be 32-byte hex: ${value}`);
  return value.toLowerCase() as Hex;
}

export function bytes32OrNull(value: string | null | undefined, label = 'value'): Hex | null {
  return value === null || value === undefined ? null : bytes32(value, label);
}

/** Random bytes32 (campaign / batch on-chain ids). */
export function randomBytes32(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** JSON value accepted by Prisma `Json` columns. */
export type JsonInput = Prisma.InputJsonValue;
