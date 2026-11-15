import { isAddress, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { UINT256_MAX, UINT64_MAX } from './amounts';

/** Any-case address (mixed case must carry a valid EIP-55 checksum), normalized to lowercase. */
export const AddressSchema = z
  .string()
  .trim()
  .refine((value) => isAddress(value), { error: 'Invalid address' })
  .transform((value) => value.toLowerCase() as Address);

const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;

/** Even-length hex, normalized to lowercase. */
export const HexSchema = z
  .string()
  .regex(HEX_BYTES, { error: 'Invalid hex bytes' })
  .transform((value) => value.toLowerCase() as Hex);

export const Bytes32Schema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, { error: 'Expected 32-byte hex' })
  .transform((value) => value.toLowerCase() as Hex);

export const TxHashSchema = Bytes32Schema;

/** 65-byte ECDSA signature (EOA). */
export const EcdsaSignatureSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{130}$/, { error: 'Expected a 65-byte signature' })
  .transform((value) => value.toLowerCase() as Hex);

/** Wallet signature: ECDSA, ERC-1271 or ERC-6492 wrapped (bounded to keep payloads small). */
export const WalletSignatureSchema = HexSchema.refine(
  (value) => value.length >= 132 && value.length <= 20_002,
  {
    error: 'Signature length out of range',
  },
);

const UNSIGNED = /^(0|[1-9]\d*)$/;

/** uint256 as a canonical decimal string (JSON-safe bigint). */
export const WeiStringSchema = z
  .string()
  .regex(UNSIGNED, { error: 'Expected a non-negative integer string' })
  .refine((value) => BigInt(value) <= UINT256_MAX, { error: 'Exceeds uint256' });

/** Signed integer string (net flows). */
export const SignedWeiStringSchema = z
  .string()
  .regex(/^(0|-?[1-9]\d*)$/, { error: 'Expected an integer string' });

/** uint64 block number as a decimal string. */
export const BlockNumberStringSchema = z
  .string()
  .regex(UNSIGNED, { error: 'Expected a block number' })
  .refine((value) => BigInt(value) <= UINT64_MAX, { error: 'Exceeds uint64' });

export const IsoDateTimeSchema = z.iso.datetime();
export const UuidSchema = z.uuid();
export const LocaleSchema = z.enum(['en', 'es']);
export type Locale = z.infer<typeof LocaleSchema>;

/** BCP-47 subset: `en`, `es`, `pt-BR`. */
export const LanguageCodeSchema = z
  .string()
  .regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/, { error: 'Invalid language code' });
export const RatioSchema = z.number().min(0).max(1);
export const NonNegativeIntSchema = z.int().min(0);

export function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** JSON value whose serialized UTF-8 size is at most `maxBytes`. */
export function boundedJson(maxBytes: number) {
  return z.json().refine((value) => jsonByteLength(value) <= maxBytes, {
    error: `JSON payload exceeds ${maxBytes} bytes`,
  });
}
