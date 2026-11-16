import 'server-only';
import { convertTrialToVerified, getTrialSession, recordAlert, type PrismaClient } from '@veriwork/database';
import type { Address } from 'viem';
import { logServerError } from '../log';

export const TRIAL_CONVERSION_ALERT_SOURCE = 'trial-conversion';

/**
 * A trial wallet is now verified: records the conversion once (attaches the root to its trial work
 * and voids trial work its own human decided from another wallet). Self-decided work the database
 * could not void any more (batch frozen or settled) raises a critical alert for the operator, who
 * can have the guardian veto the epoch. Never fails the request that triggered it.
 */
export async function convertTrialIfNeeded(db: PrismaClient, wallet: Address, root: Address, now: Date): Promise<void> {
  try {
    const session = await getTrialSession(db, wallet);
    if (session === null || session.convertedToVerifiedAt !== null) return;
    const conversion = await convertTrialToVerified(db, wallet, root, now);
    if (conversion === null || conversion.unresolvedSelfReviews.length === 0) return;
    await recordAlert(db, {
      severity: 'CRITICAL',
      source: TRIAL_CONVERSION_ALERT_SOURCE,
      message: `Trial work of ${wallet} was reviewed or voted on by the same human (root ${root}) and its batch is already frozen: check the epoch before it becomes claimable.`,
      details: { wallet, root, submissionIds: [...conversion.unresolvedSelfReviews] },
      now,
    });
  } catch (error: unknown) {
    logServerError('trial_conversion_failed', error);
  }
}
