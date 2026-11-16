import type { IdentityResponse, IdentitySummary } from '@/lib/api/schemas';
import type { IdentitySnapshot } from './types';

function isoFromSeconds(seconds: number | null): string | null {
  return seconds === null ? null : new Date(seconds * 1_000).toISOString();
}

export function toIdentitySummary(snapshot: IdentitySnapshot): IdentitySummary {
  return {
    status: snapshot.status,
    root: snapshot.root,
    expiresAt: isoFromSeconds(snapshot.expiresAt),
    isFirstWindow: snapshot.isFirstWindow,
    checkedAt: isoFromSeconds(snapshot.checkedAt),
  };
}

export function toIdentityResponse(snapshot: IdentitySnapshot): IdentityResponse {
  return { address: snapshot.address, ...toIdentitySummary(snapshot) };
}
