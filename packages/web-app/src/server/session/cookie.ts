import { SESSION_COOKIE_NAME, SESSION_TTL_SECONDS } from '@veriwork/shared/api/auth';

export interface CookieOptions {
  readonly secure: boolean;
}

function withFlags(attributes: readonly string[], options: CookieOptions): string {
  const flags = ['Path=/', 'HttpOnly', 'SameSite=Lax', ...(options.secure ? ['Secure'] : [])];
  return [...attributes, ...flags].join('; ');
}

/** `vw_session`: HttpOnly, SameSite=Lax, Secure in production, 24 h. */
export function sessionCookie(token: string, options: CookieOptions): string {
  return withFlags([`${SESSION_COOKIE_NAME}=${token}`, `Max-Age=${SESSION_TTL_SECONDS}`], options);
}

export function clearedSessionCookie(options: CookieOptions): string {
  return withFlags([`${SESSION_COOKIE_NAME}=`, 'Max-Age=0', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT'], options);
}
