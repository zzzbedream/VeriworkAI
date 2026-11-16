import 'server-only';
import { SESSION_TTL_SECONDS, SessionClaimsSchema } from '@veriwork/shared/api/auth';
import { jwtVerify, SignJWT } from 'jose';
import type { Address } from 'viem';
import { ConfigError } from '../http/errors';

export const MIN_SESSION_SECRET_BYTES = 32;
const MAX_TOKEN_LENGTH = 2_048;
const ISSUER = 'veriwork-web';

/** HS256 key from `SESSION_SECRET`; refuses to run without at least 32 bytes of secret. */
export function sessionKeyFromSecret(secret: string | undefined): Uint8Array {
  if (secret === undefined || secret.trim() === '') throw new ConfigError('SESSION_SECRET is not set');
  const key = new TextEncoder().encode(secret);
  if (key.length < MIN_SESSION_SECRET_BYTES) {
    throw new ConfigError(`SESSION_SECRET must be at least ${MIN_SESSION_SECRET_BYTES} bytes`);
  }
  return key;
}

export interface IssuedSession {
  readonly token: string;
  readonly expiresAt: Date;
}

/** 24 h session for a lowercase wallet address, bound to this deployment's SIWE domain. */
export async function issueSessionToken(
  address: Address,
  key: Uint8Array,
  audience: string,
  now: Date,
): Promise<IssuedSession> {
  const issuedAt = Math.floor(now.getTime() / 1_000);
  const expiresAt = issuedAt + SESSION_TTL_SECONDS;
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(address.toLowerCase())
    .setIssuer(ISSUER)
    .setAudience(audience)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(key);
  return { token, expiresAt: new Date(expiresAt * 1_000) };
}

/** Lowercase address of a valid, unexpired session token; `null` for anything else. */
export async function readSessionToken(
  token: string,
  key: Uint8Array,
  audience: string,
  now: Date,
): Promise<Address | null> {
  if (token === '' || token.length > MAX_TOKEN_LENGTH) return null;
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience,
      currentDate: now,
    });
    const claims = SessionClaimsSchema.safeParse(payload);
    return claims.success ? claims.data.sub : null;
  } catch {
    // Expired, tampered or foreign tokens are simply "no session".
    return null;
  }
}
