import 'server-only';
import { formatValidationIssues } from '@veriwork/shared/api/envelope';
import { AddressSchema } from '@veriwork/shared/schemas';
import { z } from 'zod';
import type { ServerDeps } from '../deps';
import { jsonOk } from '../http/envelope';
import { ApiFailure } from '../http/errors';
import { enforceRateLimit, RATE_LIMITS } from '../http/rate-limit';
import { clientIp } from '../http/request';
import { apiRoute, type RouteHandler } from '../http/route';
import { toIdentityResponse } from '../identity/summary';

/** While a user returns from face verification the UI polls with `fresh=1`: at most 5 s old. */
export const POLL_MAX_AGE_MS = 5_000;

const IdentityQuerySchema = z.strictObject({
  address: AddressSchema,
  fresh: z.literal('1').optional(),
});

/** GET /api/identity?address=0x…: public GoodID status of any account (public on-chain data). */
export function createIdentityHandler(deps: ServerDeps): RouteHandler {
  return apiRoute('identity', async (request) => {
    const query = IdentityQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!query.success) throw new ApiFailure('VALIDATION_FAILED', formatValidationIssues(query.error));
    await enforceRateLimit(deps.db(), RATE_LIMITS.identity, clientIp(request), deps.now());
    const { snapshot } = await deps
      .identity()
      .read(query.data.address, query.data.fresh === undefined ? {} : { maxAgeMs: POLL_MAX_AGE_MS });
    return jsonOk(toIdentityResponse(snapshot));
  });
}
