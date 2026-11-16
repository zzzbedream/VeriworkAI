import 'server-only';
import { AddressSchema, IsoDateTimeSchema } from '@veriwork/shared/schemas';
import { z } from 'zod';
import { jsonError, jsonOk } from '../http/envelope';
import { readJsonBody } from '../http/request';
import { apiRoute, type RouteHandler } from '../http/route';
import { resetMockIdentities, setMockIdentity } from '../identity/mock-reader';

const MockEntrySchema = z.strictObject({
  address: AddressSchema,
  status: z.enum(['verified', 'unverified', 'expired']),
  root: AddressSchema.nullable().optional(),
  expiresAt: IsoDateTimeSchema.nullable().optional(),
  isFirstWindow: z.boolean().optional(),
  delayMs: z.int().min(0).max(5_000).optional(),
});

const MockRequestSchema = z.union([z.strictObject({ reset: z.literal(true) }), MockEntrySchema]);

/**
 * POST /api/e2e/identity: scripts mock GoodID identities for Playwright. Answers 404 unless the
 * E2E guard (E2E_MODE=1 on a non-mainnet build) is satisfied.
 */
export function createE2EIdentityHandler(isEnabled: () => boolean): RouteHandler {
  return apiRoute('e2e.identity', async (request) => {
    if (!isEnabled()) return jsonError('NOT_FOUND', 'Not found.');
    const body = await readJsonBody(request, MockRequestSchema);
    if ('reset' in body) {
      resetMockIdentities();
      return jsonOk({ reset: true });
    }
    setMockIdentity(body.address, {
      status: body.status,
      root: body.root ?? null,
      expiresAt: body.expiresAt ? Math.floor(Date.parse(body.expiresAt) / 1_000) : null,
      isFirstWindow: body.isFirstWindow ?? false,
      delayMs: body.delayMs ?? 0,
    });
    return jsonOk({ address: body.address });
  });
}
