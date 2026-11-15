import { z } from 'zod';
import { AddressSchema, IsoDateTimeSchema, WalletSignatureSchema } from '../schemas';

/** SIWE session cookie (HttpOnly, Secure, SameSite=Lax, JWT HS256). */
export const SESSION_COOKIE_NAME = 'vw_session';
export const SESSION_TTL_SECONDS = 24 * 60 * 60;
/** SIWE nonces live 10 minutes and are single use. */
export const AUTH_NONCE_TTL_SECONDS = 10 * 60;
/** EIP-4361 messages are a few hundred bytes; anything bigger is refused before parsing. */
export const SIWE_MESSAGE_MAX_LENGTH = 4_096;

/** EIP-4361 nonce: at least 8 alphanumeric characters (viem's `generateSiweNonce` gives 96). */
export const SiweNonceSchema = z
  .string()
  .regex(/^[A-Za-z0-9]{8,96}$/, { error: 'Invalid SIWE nonce' });

/** POST /api/auth/nonce */
export const AuthNonceResponseSchema = z.strictObject({
  nonce: SiweNonceSchema,
  expiresAt: IsoDateTimeSchema,
});

/** POST /api/auth/verify */
export const AuthVerifyRequestSchema = z.strictObject({
  message: z.string().min(1).max(SIWE_MESSAGE_MAX_LENGTH),
  signature: WalletSignatureSchema,
});

export const AuthVerifyResponseSchema = z.strictObject({
  address: AddressSchema,
  expiresAt: IsoDateTimeSchema,
});

/** POST /api/auth/logout */
export const LogoutResponseSchema = z.strictObject({ loggedOut: z.literal(true) });

/** Claims inside the `vw_session` JWT: the subject is the lowercase wallet address. */
export const SessionClaimsSchema = z.object({
  sub: AddressSchema,
  iat: z.int().nonnegative(),
  exp: z.int().positive(),
});

export type AuthNonceResponse = z.infer<typeof AuthNonceResponseSchema>;
export type AuthVerifyRequest = z.infer<typeof AuthVerifyRequestSchema>;
export type AuthVerifyResponse = z.infer<typeof AuthVerifyResponseSchema>;
export type LogoutResponse = z.infer<typeof LogoutResponseSchema>;
export type SessionClaims = z.infer<typeof SessionClaimsSchema>;
