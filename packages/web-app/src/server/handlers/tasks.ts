import 'server-only';
import {
  createSubmission,
  ensureUser,
  getNextTaskForWorker,
  getTrialSession,
  type PrismaClient,
} from '@veriwork/database';
import {
  NextTaskQuerySchema,
  SubmitTaskRequestSchema,
  TaskItemParamsSchema,
  type NextTaskQuery,
  type NextTaskResponse,
  type SubmitTaskResponse,
} from '@veriwork/shared/api/work';
import { LanguageCodeSchema } from '@veriwork/shared/schemas';
import type { Address } from 'viem';
import type { ServerDeps } from '../deps';
import { jsonOk } from '../http/envelope';
import { ApiFailure } from '../http/errors';
import { assertSameOrigin } from '../http/origin';
import { enforceRateLimit, RATE_LIMITS } from '../http/rate-limit';
import { parseInput, readJsonBody, readQuery } from '../http/request';
import { apiRoute, apiRouteWithParams, type ParamsRouteHandler, type RouteHandler } from '../http/route';
import { PAYING_ACTION_MAX_AGE_MS, readCallerIdentity, verifiedRootOf } from '../identity/caller';
import { requireSessionAddress } from '../session/current';
import { assertModuleAccess, checkCorrection, loadTaskContent } from '../work/correction';
import { submissionFailure } from '../work/failures';
import { convertTrialIfNeeded } from '../work/trial-conversion';
import { toTaskItemView, trialSummaryOf } from '../work/views';

/** An explicit `?language=` wins; otherwise the profile's languages (none = every campaign). */
function languagesFor(query: NextTaskQuery, profileLanguages: readonly string[]): readonly string[] {
  if (query.language !== undefined) return [query.language];
  return profileLanguages.filter((language) => LanguageCodeSchema.safeParse(language).success);
}

async function nextTrialTask(db: PrismaClient, address: Address, languages: readonly string[]): Promise<NextTaskResponse> {
  const trial = trialSummaryOf(await getTrialSession(db, address));
  if (trial.remaining === 0) {
    throw new ApiFailure(
      'VERIFICATION_REQUIRED',
      'You finished your 2 free tasks. Verify to keep working: your earnings are saved for you.',
    );
  }
  const task = await getNextTaskForWorker(db, { walletAddress: address, root: null, languages });
  return { task: task === null ? null : toTaskItemView(task, true), trial };
}

async function nextVerifiedTask(
  deps: ServerDeps,
  address: Address,
  root: Address,
  languages: readonly string[],
  now: Date,
): Promise<NextTaskResponse> {
  const db = deps.db();
  await convertTrialIfNeeded(db, address, root, now);
  const ownedModuleIds = await deps.chain().ownedModules(root);
  const task = await getNextTaskForWorker(db, { walletAddress: address, root, languages, ownedModuleIds });
  return { task: task === null ? null : toTaskItemView(task, false), trial: null };
}

/**
 * GET /api/tasks/next: verified workers get the next eligible item; unverified callers get trial
 * items while they have free tasks left, then 409 VERIFICATION_REQUIRED.
 */
export function createNextTaskHandler(deps: ServerDeps): RouteHandler {
  return apiRoute('tasks.next', async (request) => {
    const address = await requireSessionAddress(request, deps);
    const now = deps.now();
    const db = deps.db();
    await enforceRateLimit(db, RATE_LIMITS.nextTask, address, now);
    const query = readQuery(request, NextTaskQuerySchema);
    const user = await ensureUser(db, address);
    const root = verifiedRootOf(await readCallerIdentity(deps, address));
    const languages = languagesFor(query, user.languages);
    const data =
      root === null ? await nextTrialTask(db, address, languages) : await nextVerifiedTask(deps, address, root, languages, now);
    return jsonOk(data);
  });
}

/**
 * POST /api/tasks/{itemId}/submit: module requirement (on-chain) and correction are checked against
 * the item, then the submission is stored. Trial
 * work counts and saves its reward atomically (never more than 2 tasks per wallet, even under
 * concurrent requests); verified work also marks today's Wallet Week task.
 */
export function createSubmitTaskHandler(deps: ServerDeps): ParamsRouteHandler {
  return apiRouteWithParams('tasks.submit', async (request, params) => {
    const config = deps.config();
    const now = deps.now();
    const db = deps.db();
    assertSameOrigin(request, config.appOrigin);
    const address = await requireSessionAddress(request, deps);
    await enforceRateLimit(db, RATE_LIMITS.submitTask, address, now);
    const { itemId } = parseInput(TaskItemParamsSchema, params);
    const body = await readJsonBody(request, SubmitTaskRequestSchema);
    await ensureUser(db, address);
    const root = verifiedRootOf(await readCallerIdentity(deps, address, { maxAgeMs: PAYING_ACTION_MAX_AGE_MS }));
    const content = await loadTaskContent(db, itemId);
    await assertModuleAccess(deps.chain(), content, root);
    const correction = checkCorrection(content, body.correction);
    const result = await createSubmission(db, {
      itemId,
      workerAddress: address,
      workerRoot: root,
      isTrial: root === null,
      correction,
      now,
    });
    if (!result.ok) throw submissionFailure(result.reason);
    const data: SubmitTaskResponse = {
      submissionId: result.submission.id,
      status: result.submission.status,
      isTrial: result.submission.isTrial,
      trial: result.trial === null ? null : trialSummaryOf(result.trial),
    };
    return jsonOk(data, { status: 201 });
  });
}
