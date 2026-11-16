import {
  leaseGasTopUps,
  markGasTopUpFailed,
  markGasTopUpSent,
  type GasTopUpRecord,
} from '@veriwork/database';
import { faucetAbi, GAS_TOP_UP_THRESHOLD_WEI } from '@veriwork/shared';
import { BroadcastError, ChainWriteError, TxRevertedError } from '../chain/errors';
import { faucetCanTop, requireProtocol, whitelistedRoot } from '../chain/contracts';
import { sendOrResume } from '../chain/tx-step';
import type { WorkerContext } from '../runtime/context';
import { required, type Job, type JobSummary } from '../runtime/job';
import { forEachItem } from '../util/each';

const REQUESTS_PER_RUN = 20;
const LEASE_SECONDS = 300;

export type TopUpOutcome = 'sent' | 'refused' | 'failed';

/** Re-checks right before paying gas: still verified, still below 0.21 CELO, and `canTop`. */
async function refusalReason(ctx: WorkerContext, request: GasTopUpRecord): Promise<string | null> {
  const root = await whitelistedRoot(ctx.chain, request.walletAddress);
  if (root === null) return 'NOT_VERIFIED';
  const balance = await ctx.chain.publicClient.getBalance({ address: request.walletAddress });
  if (balance >= GAS_TOP_UP_THRESHOLD_WEI) return 'BALANCE_ABOVE_THRESHOLD';
  if (!(await faucetCanTop(ctx.chain, request.walletAddress))) return 'FAUCET_REFUSED';
  return null;
}

async function topUp(ctx: WorkerContext, request: GasTopUpRecord): Promise<TopUpOutcome> {
  const reason = await refusalReason(ctx, request);
  if (reason !== null) {
    await markGasTopUpFailed(ctx.db, request.id, reason, ctx.clock.now());
    return 'refused';
  }
  try {
    await sendOrResume(required(ctx.chain.operator, 'OPERATOR_PRIVATE_KEY'), {
      write: {
        label: 'topWallet',
        address: requireProtocol(ctx.chain).faucet,
        abi: faucetAbi,
        functionName: 'topWallet',
        args: [request.walletAddress],
      },
      persistedHash: null,
      persist: async (hash) => {
        await markGasTopUpSent(ctx.db, request.id, hash, ctx.clock.now());
      },
    });
    return 'sent';
  } catch (error: unknown) {
    const failure = definiteFailure(error);
    // Anything else (RPC outage, a pending operator transaction) is transient: the lease expires and
    // a later run retries the request (attempts are capped by the repository).
    if (failure === null) throw error;
    await markGasTopUpFailed(ctx.db, request.id, failure, ctx.clock.now());
    return 'failed';
  }
}

/** A revert after the broadcast, or a decoded revert in the simulation: the request failed. */
function definiteFailure(error: unknown): string | null {
  if (error instanceof TxRevertedError) return 'TX_REVERTED';
  if (error instanceof BroadcastError) return 'BROADCAST_FAILED';
  if (error instanceof ChainWriteError && error.key !== null) return error.key;
  return null;
}

/**
 * Executes the gas top-ups users requested from the web app: GoodDollar's Faucet
 * `topWallet(user)` from the operator key (the faucet refunds the caller's gas and caps 3 tops per
 * day per root). Requests are leased, so overlapping runs never send one twice.
 */
export const faucetRelayerJob: Job = {
  name: 'faucet-relayer',
  schedule: '*/30 * * * * *',
  enabled: (config) => config.features.faucetRelayer,
  isDue: (ctx) => Promise.resolve(ctx.chain.protocol !== null && !ctx.config.dryRun),
  async run(ctx): Promise<JobSummary> {
    const requests = await leaseGasTopUps(ctx.db, {
      limit: REQUESTS_PER_RUN,
      // Longer than a receipt wait, so a slow top-up is never leased (and sent) twice.
      leaseSeconds: Math.max(LEASE_SECONDS, Math.ceil(ctx.config.receiptTimeoutMs / 1_000) + 120),
      now: ctx.clock.now(),
    });
    const outcome = await forEachItem(
      requests,
      (request) => topUp(ctx, request),
      (request) => `top-up ${request.id}`,
      ctx.signal,
    );
    const count = (value: TopUpOutcome): number =>
      outcome.results.filter((result) => result === value).length;
    return {
      leased: requests.length,
      sent: count('sent'),
      refused: count('refused'),
      failed: count('failed') + outcome.errors.length,
    };
  },
};
