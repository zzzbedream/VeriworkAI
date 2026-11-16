import 'server-only';
import { castQaVote, ensureUser, getNextQaForVoter } from '@veriwork/database';
import {
  QaVoteRequestSchema,
  SubmissionParamsSchema,
  type NextQaResponse,
  type QaVoteResponse,
} from '@veriwork/shared/api/work';
import type { ServerDeps } from '../deps';
import { jsonOk } from '../http/envelope';
import { assertSameOrigin } from '../http/origin';
import { enforceRateLimit, RATE_LIMITS } from '../http/rate-limit';
import { parseInput, readJsonBody } from '../http/request';
import { apiRoute, apiRouteWithParams, type ParamsRouteHandler, type RouteHandler } from '../http/route';
import { PAYING_ACTION_MAX_AGE_MS, readCallerIdentity, requireVerifiedRoot } from '../identity/caller';
import { requireSessionAddress } from '../session/current';
import { decisionFailure } from '../work/failures';
import { convertTrialIfNeeded } from '../work/trial-conversion';
import { toQaItemView } from '../work/views';

/** GET /api/qa/next: a blind QA item (no reviewer verdict, no other votes, no worker identity). */
export function createNextQaHandler(deps: ServerDeps): RouteHandler {
  return apiRoute('qa.next', async (request) => {
    const address = await requireSessionAddress(request, deps);
    const now = deps.now();
    const db = deps.db();
    await enforceRateLimit(db, RATE_LIMITS.nextQa, address, now);
    await ensureUser(db, address);
    const root = requireVerifiedRoot(await readCallerIdentity(deps, address));
    await convertTrialIfNeeded(db, address, root, now);
    const candidate = await getNextQaForVoter(db, { qaAddress: address, qaRoot: root });
    const data: NextQaResponse = { submission: candidate === null ? null : toQaItemView(candidate) };
    return jsonOk(data);
  });
}

/**
 * POST /api/qa/{submissionId}: a blind vote (a reason is required to reject). The answer only
 * confirms the vote: no count, outcome or status, so voting stays blind after the vote too.
 */
export function createQaVoteHandler(deps: ServerDeps): ParamsRouteHandler {
  return apiRouteWithParams('qa.vote', async (request, params) => {
    const config = deps.config();
    const now = deps.now();
    const db = deps.db();
    assertSameOrigin(request, config.appOrigin);
    const address = await requireSessionAddress(request, deps);
    await enforceRateLimit(db, RATE_LIMITS.submitQa, address, now);
    const { submissionId } = parseInput(SubmissionParamsSchema, params);
    const body = await readJsonBody(request, QaVoteRequestSchema);
    await ensureUser(db, address);
    const root = requireVerifiedRoot(await readCallerIdentity(deps, address, { maxAgeMs: PAYING_ACTION_MAX_AGE_MS }));
    const result = await castQaVote(db, {
      submissionId,
      qaAddress: address,
      qaRoot: root,
      approve: body.approve,
      reason: body.reason,
      now,
    });
    if (!result.ok) throw decisionFailure(result.reason, 'qa');
    const data: QaVoteResponse = { submissionId: result.submissionId, recorded: true };
    return jsonOk(data);
  });
}
