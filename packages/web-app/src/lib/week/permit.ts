import { PERMIT_TYPES } from '@veriwork/shared/abis/gDollar';
import { G_DOLLAR_PERMIT_DOMAIN } from '@veriwork/shared/addresses';
import { parseSignature, type Address, type Hex } from 'viem';

/** A permit signed for the Monday deposit is good for 30 minutes. */
export const PERMIT_TTL_SECONDS = 30 * 60;

export interface PermitInput {
  readonly owner: Address;
  /** VeriWorkCore (the contract that pulls the deposit). */
  readonly spender: Address;
  /** The permit value is also the most the user accepts to deposit (`depositStakeWithPermit(value, ...)`). */
  readonly value: bigint;
  readonly nonce: bigint;
  readonly deadline: bigint;
}

/**
 * EIP-2612 typed data for G$. G$ has no EIP-5267 `eip712Domain()`, so the domain is fixed:
 * `{ name: 'GoodDollar', version: '1', chainId: 42220, verifyingContract: G$ }`.
 */
export function permitTypedData(input: PermitInput) {
  return {
    domain: G_DOLLAR_PERMIT_DOMAIN,
    types: PERMIT_TYPES,
    primaryType: 'Permit' as const,
    message: {
      owner: input.owner,
      spender: input.spender,
      value: input.value,
      nonce: input.nonce,
      deadline: input.deadline,
    },
  };
}

/** `v, r, s` of a 65-byte signature, as `depositStakeWithPermit` takes them (`v` is 27 or 28). */
export function permitSignatureParts(signature: Hex): { readonly v: number; readonly r: Hex; readonly s: Hex } {
  const parsed = parseSignature(signature);
  const v = parsed.v === undefined ? parsed.yParity + 27 : Number(parsed.v);
  return { v, r: parsed.r, s: parsed.s };
}
