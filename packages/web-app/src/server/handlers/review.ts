import 'server-only';
import { ensureUser, getNextReviewForReviewer, submitReview } from '@veriwork/database';
import {
  ReviewRequestSchema,
  SubmissionParamsSchema,
  type NextReviewResponse,
  type ReviewResponse,
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
import { toReviewItemView } from '../work/views';

/** GET /api/review/next: oldest submission this verified reviewer may decide (`null` when none or not qualified). */
export function createNextReviewHandler(deps: ServerDeps): RouteHandler {
  return apiRoute('review.next', async (request) => {
    const address = await requireSessionAddress(request, deps);
    const now = deps.now();
    const db = deps.db();
    await enforceRateLimit(db, RATE_LIMITS.nextReview, address, now);
    await ensureUser(db, address);
    const root = requireVerifiedRoot(await readCallerIdentity(deps, address));
    await convertTrialIfNeeded(db, address, root, now);
    const candidate = await getNextReviewForReviewer(db, { reviewerAddress: address, reviewerRoot: root });
    const data: NextReviewResponse = { submission: candidate === null ? null : toReviewItemView(candidate) };
    return jsonOk(data);
  });
}

/** POST /api/review/{submissionId}: score 1-5 (a reason below 3); the work always moves on to QA. */
export function createSubmitReviewHandler(deps: ServerDeps): ParamsRouteHandler {
  return apiRouteWithParams('review.submit', async (request, params) => {
    const config = deps.config();
    const now = deps.now();
    const db = deps.db();
    assertSameOrigin(request, config.appOrigin);
    const address = await requireSessionAddress(request, deps);
    await enforceRateLimit(db, RATE_LIMITS.submitReview, address, now);
    const { submissionId } = parseInput(SubmissionParamsSchema, params);
    const body = await readJsonBody(request, ReviewRequestSchema);
    await ensureUser(db, address);
    const root = requireVerifiedRoot(await readCallerIdentity(deps, address, { maxAgeMs: PAYING_ACTION_MAX_AGE_MS }));
    const result = await submitReview(db, {
      submissionId,
      reviewerAddress: address,
      reviewerRoot: root,
      score: body.score,
      notes: body.notes,
      now,
    });
    if (!result.ok) throw decisionFailure(result.reason, 'review');
    const data: ReviewResponse = { submissionId: result.submission.id, status: result.submission.status };
    return jsonOk(data);
  });
}
