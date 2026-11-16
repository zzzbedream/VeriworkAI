import { createE2EIdentityHandler } from '@/server/handlers/e2e-identity';
import { isMockIdentityEnabled } from '@/server/identity/registry';

/** Playwright-only: 404 unless E2E_MODE=1 on a non-mainnet build. */
export const POST = createE2EIdentityHandler(isMockIdentityEnabled);
