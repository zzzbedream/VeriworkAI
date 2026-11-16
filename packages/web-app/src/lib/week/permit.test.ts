import { GOODDOLLAR_CELO } from '@veriwork/shared/addresses';
import { gDollars } from '@veriwork/shared/amounts';
import { domainSeparator, parseSignature, recoverTypedDataAddress, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { PERMIT_TTL_SECONDS, permitSignatureParts, permitTypedData } from './permit';

const CORE = '0xeC9Ea648d5F8C3bcb5E26Bd155dCf27Ed4B51c25' as Address;
/** `G$.DOMAIN_SEPARATOR()` read on Celo mainnet (2026-11-16). */
const MAINNET_DOMAIN_SEPARATOR = '0x435c8fd3419db35c33fa5716d6e80b61799c9562dab19af45e645a11c92098aa';

describe('G$ EIP-2612 permit for the Monday deposit', () => {
  it('uses the fixed GoodDollar domain on Celo mainnet (G$ has no eip712Domain())', () => {
    const owner = privateKeyToAccount(generatePrivateKey()).address;
    const typedData = permitTypedData({ owner, spender: CORE, value: gDollars(150n), nonce: 3n, deadline: 1_800_000_000n });
    expect(typedData.domain).toEqual({ name: 'GoodDollar', version: '1', chainId: 42220, verifyingContract: GOODDOLLAR_CELO.gDollar });
    expect(typedData.primaryType).toBe('Permit');
    expect(typedData.types.Permit.map((field) => `${field.type} ${field.name}`)).toEqual([
      'address owner',
      'address spender',
      'uint256 value',
      'uint256 nonce',
      'uint256 deadline',
    ]);
    expect(typedData.message).toEqual({ owner, spender: CORE, value: gDollars(150n), nonce: 3n, deadline: 1_800_000_000n });
    const separator = domainSeparator({ domain: typedData.domain });
    expect(separator).toBe(MAINNET_DOMAIN_SEPARATOR);
    expect(PERMIT_TTL_SECONDS).toBe(1_800);
  });

  it('produces a signature that recovers to the owner, split into v, r and s', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const typedData = permitTypedData({
      owner: account.address,
      spender: CORE,
      value: gDollars(150n),
      nonce: 0n,
      deadline: 1_800_000_000n,
    });
    const signature = await account.signTypedData(typedData);
    expect(await recoverTypedDataAddress({ ...typedData, signature })).toBe(account.address);
    const parts = permitSignatureParts(signature);
    const parsed = parseSignature(signature);
    expect(parts).toEqual({ v: Number(parsed.v), r: parsed.r, s: parsed.s });
    expect([27, 28]).toContain(parts.v);
  });

  it('turns a yParity-only signature into v = 27 / 28', () => {
    const r = `0x${'11'.repeat(32)}`;
    const s = `0x${'22'.repeat(32)}`;
    expect(permitSignatureParts(`${r}${s.slice(2)}00` as Hex)).toEqual({ v: 27, r, s });
    expect(permitSignatureParts(`${r}${s.slice(2)}01` as Hex).v).toBe(28);
  });
});
