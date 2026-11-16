import { AUTH_NONCE_TTL_SECONDS } from '@veriwork/shared/api/auth';
import { getAddress, type Address } from 'viem';
import { createSiweMessage } from 'viem/siwe';

/** Sign-in messages are only accepted for a few minutes (the nonce itself lives 10 minutes). */
export const SIGN_IN_MESSAGE_TTL_MS = 10 * 60_000;

/**
 * Server time at which the nonce was issued (its expiry minus the nonce lifetime). Using it as the
 * message's `issuedAt` keeps sign-in working on devices whose clock is wrong; `fallback` (the device
 * clock) is used only when the server sent no valid expiry.
 */
export function issuedAtForNonce(expiresAt: string | undefined, fallback: Date): Date {
  const expiry = expiresAt === undefined ? Number.NaN : Date.parse(expiresAt);
  return Number.isFinite(expiry) ? new Date(expiry - AUTH_NONCE_TTL_SECONDS * 1_000) : fallback;
}

export interface SignInMessageInput {
  readonly address: Address;
  readonly chainId: number;
  readonly nonce: string;
  /** `window.location.host`: what the wallet shows and the server checks against SIWE_DOMAIN. */
  readonly domain: string;
  /** `window.location.origin` */
  readonly uri: string;
  readonly statement: string;
  readonly issuedAt: Date;
}

/** EIP-4361 message for a free sign-in signature (no transaction, no fee). */
export function createSignInMessage(input: SignInMessageInput): string {
  return createSiweMessage({
    address: getAddress(input.address),
    chainId: input.chainId,
    domain: input.domain,
    nonce: input.nonce,
    uri: input.uri,
    version: '1',
    statement: input.statement,
    issuedAt: input.issuedAt,
    expirationTime: new Date(input.issuedAt.getTime() + SIGN_IN_MESSAGE_TTL_MS),
  });
}
