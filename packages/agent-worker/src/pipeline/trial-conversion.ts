import {
  claimNotification,
  convertTrialToVerified,
  getTrialSession,
  listUsers,
  markNotificationSent,
  type UserRecord,
} from '@veriwork/database';
import { whitelistedRoot } from '../chain/contracts';
import type { WorkerContext } from '../runtime/context';
import type { Job, JobSummary } from '../runtime/job';
import { forEachItem, throwIfFailed } from '../util/each';

/** Conversions done elsewhere (the web app) are re-checked for this long, to surface their alerts. */
const RECHECK_CONVERTED_MS = 2 * 86_400_000;
const PAGE_SIZE = 200;
const MAX_PAGES = 25;

type ConversionOutcome = 'converted' | 'rechecked' | 'not-trial' | 'not-verified' | 'dry-run';

/** Verified users, keyset-paginated (bounded per run). */
export async function verifiedUsers(ctx: WorkerContext): Promise<readonly UserRecord[]> {
  const pages: UserRecord[][] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await listUsers(ctx.db, {
      verifiedOnly: true,
      limit: PAGE_SIZE,
      ...(after === undefined ? {} : { after }),
    });
    pages.push([...result.users]);
    if (result.nextCursor === null) break;
    after = result.nextCursor;
  }
  return pages.flat();
}

/** One alert per unresolved self-reviewed submission, ever (the notification ledger dedupes it). */
async function alertSelfReviews(
  ctx: WorkerContext,
  wallet: string,
  submissionIds: readonly string[],
): Promise<void> {
  for (const submissionId of submissionIds) {
    const claim = await claimNotification(ctx.db, {
      dedupeKey: `trial-self-review:${submissionId}`,
      kind: 'trial-self-review-alert',
      walletAddress: wallet,
      now: ctx.clock.now(),
    });
    if (!claim.claimed) continue;
    await ctx.alerts.raise({
      severity: 'CRITICAL',
      source: 'trial-conversion',
      message:
        `Trial submission ${submissionId} of ${wallet} was reviewed by the same human and its batch ` +
        'is already frozen: if it was accepted, consider a guardian veto of its epoch',
      details: { submissionId, wallet },
    });
    await markNotificationSent(ctx.db, claim.id, ctx.clock.now());
  }
}

async function convertUser(ctx: WorkerContext, user: UserRecord): Promise<ConversionOutcome> {
  const session = await getTrialSession(ctx.db, user.walletAddress);
  if (session === null) return 'not-trial';
  const converted = session.convertedToVerifiedAt;
  if (
    converted !== null &&
    ctx.clock.now().getTime() - converted.getTime() > RECHECK_CONVERTED_MS
  ) {
    return 'not-trial';
  }
  // Server-side re-check: the cached root must still resolve on-chain.
  const root = await whitelistedRoot(ctx.chain, user.walletAddress);
  if (root === null) return 'not-verified';
  if (ctx.config.dryRun) return 'dry-run';
  const result = await convertTrialToVerified(ctx.db, user.walletAddress, root, ctx.clock.now());
  if (result !== null && result.unresolvedSelfReviews.length > 0) {
    await alertSelfReviews(ctx, user.walletAddress, result.unresolvedSelfReviews);
  }
  return converted === null ? 'converted' : 'rechecked';
}

/**
 * Trial wallets that passed GoodID: records the conversion (attaching the root so conflict checks
 * see the human, voiding trial work the same human reviewed from another wallet) and alerts the
 * operator about self-reviewed work whose batch is already frozen (`unresolvedSelfReviews`).
 */
export const trialConversionJob: Job = {
  name: 'trial-conversion',
  schedule: '*/5 * * * *',
  enabled: (config) => config.features.pipeline,
  isDue: () => Promise.resolve(true),
  async run(ctx): Promise<JobSummary> {
    const users = await verifiedUsers(ctx);
    const outcome = await forEachItem(
      users,
      (user) => convertUser(ctx, user),
      (user) => `wallet ${user.walletAddress}`,
      ctx.signal,
    );
    throwIfFailed('trial conversions', outcome);
    const count = (value: ConversionOutcome): number =>
      outcome.results.filter((result) => result === value).length;
    return {
      verifiedUsers: users.length,
      converted: count('converted'),
      rechecked: count('rechecked'),
      notVerifiedOnChain: count('not-verified'),
    };
  },
};
