import { AUTH_NONCE_TTL_SECONDS, SiweNonceSchema } from '@veriwork/shared/api/auth';
import { isAddress, type Address, type Hex, type PublicClient } from 'viem';
import { parseSiweMessage } from 'viem/siwe';
import { ApiFailure } from '../http/errors';

/** Wallet and server clocks may disagree a little. */
const CLOCK_SKEW_MS = 5 * 60_000;

export interface SiweExpectations {
  readonly domain: string;
  readonly appOrigin: string;
  readonly chainId: number;
  readonly now: Date;
}

export interface ValidatedSiweMessage {
  /** Lowercase signer address claimed by the message (proven by the signature check). */
  readonly address: Address;
  readonly nonce: string;
}

function reject(): never {
  throw new ApiFailure('SIGNATURE_INVALID', 'This sign-in request is not valid for this site. Please sign in again.');
}

function sameOrigin(uri: string, origin: string): boolean {
  try {
    return new URL(uri).origin === origin;
  } catch {
    return false;
  }
}

function isValidDate(value: Date | undefined): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

/**
 * EIP-4361 field checks before the signature: domain, URI origin, chain, version, nonce format and
 * time bounds (issued recently, not expired, not before its start).
 */
export function validateSiweFields(message: string, expected: SiweExpectations): ValidatedSiweMessage {
  const fields = parseSiweMessage(message);
  if (fields.address === undefined || !isAddress(fields.address, { strict: false })) reject();
  if (fields.domain !== expected.domain || fields.version !== '1') reject();
  if (fields.chainId !== expected.chainId) reject();
  if (fields.uri === undefined || !sameOrigin(fields.uri, expected.appOrigin)) reject();
  if (fields.nonce === undefined || !SiweNonceSchema.safeParse(fields.nonce).success) reject();
  const now = expected.now.getTime();
  if (!isValidDate(fields.issuedAt)) reject();
  const issuedAt = fields.issuedAt.getTime();
  if (issuedAt > now + CLOCK_SKEW_MS || issuedAt < now - AUTH_NONCE_TTL_SECONDS * 1_000 - CLOCK_SKEW_MS) reject();
  if (fields.expirationTime !== undefined && !(isValidDate(fields.expirationTime) && fields.expirationTime.getTime() > now)) {
    reject();
  }
  if (fields.notBefore !== undefined && !(isValidDate(fields.notBefore) && fields.notBefore.getTime() <= now)) {
    reject();
  }
  return { address: fields.address.toLowerCase() as Address, nonce: fields.nonce };
}

export interface SiweSignatureInput {
  readonly message: string;
  readonly signature: Hex;
  readonly domain: string;
  readonly nonce: string;
  readonly time: Date;
}

/** Resolves `true` only for a valid signature by the message's address (EOA, ERC-1271 or ERC-6492). */
export type SiweSignatureVerifier = (input: SiweSignatureInput) => Promise<boolean>;

export function siweVerifierFor(client: Pick<PublicClient, 'verifySiweMessage'>): SiweSignatureVerifier {
  return (input) => client.verifySiweMessage({ ...input });
}
