import {
  getLastGuardianAction,
  recordGuardianAction,
  updateGuardianAction,
} from '@veriwork/database';
import { agentRegistryAbi, veriWorkCoreAbi } from '@veriwork/shared';
import type { Address } from 'viem';
import { revertKeyOf } from '../chain/errors';
import { contractAddress, isPaused, readEpoch } from '../chain/contracts';
import { sendOrResume } from '../chain/tx-step';
import type { ContractWrite } from '../chain/tx-sender';
import { createScrubber, errorMessage } from '../logging/logger';
import type { WorkerContext } from '../runtime/context';
import { required } from '../runtime/job';

export type GuardianOutcome = 'paused' | 'vetoed' | 'already' | 'cooldown' | 'dry-run';

type ActionKind = 'PAUSE' | 'VETO_EPOCH';

/** Reverts meaning "someone already did it": the action is recorded as SKIPPED. */
const ALREADY_DONE = new Set(['ENFORCED_PAUSE', 'EPOCH_IS_VETOED', 'EPOCH_IS_SWEPT']);

/** A PENDING / SENT action of the same kind within the cooldown: never stack a second one. */
async function inCooldown(
  ctx: WorkerContext,
  kind: ActionKind,
  target: Address,
  epochId: number | undefined,
): Promise<boolean> {
  const last = await getLastGuardianAction(ctx.db, {
    kind,
    contractAddress: target,
    ...(epochId === undefined ? {} : { epochId }),
    statuses: ['PENDING', 'SENT'],
  });
  const cooldownMs = ctx.config.sentinel.guardianCooldownMinutes * 60_000;
  return last !== null && ctx.clock.now().getTime() - last.createdAt.getTime() < cooldownMs;
}

/** Records the action (audit log), sends it from the guardian key and records the result. */
async function act(
  ctx: WorkerContext,
  kind: ActionKind,
  target: Address,
  write: ContractWrite,
  reason: string,
  epochId?: number,
): Promise<'done' | 'already'> {
  const action = await recordGuardianAction(ctx.db, {
    kind,
    contractAddress: target,
    reason,
    ...(epochId === undefined ? {} : { epochId }),
    now: ctx.clock.now(),
  });
  try {
    await sendOrResume(required(ctx.chain.guardian, 'GUARDIAN_PRIVATE_KEY'), {
      write,
      persistedHash: null,
      persist: async (hash) => {
        await updateGuardianAction(ctx.db, action.id, { status: 'SENT', txHash: hash });
      },
    });
    await updateGuardianAction(ctx.db, action.id, { status: 'CONFIRMED' });
    return 'done';
  } catch (error: unknown) {
    const key = revertKeyOf(error);
    if (key !== null && ALREADY_DONE.has(key)) {
      await updateGuardianAction(ctx.db, action.id, { status: 'SKIPPED', error: key });
      return 'already';
    }
    await updateGuardianAction(ctx.db, action.id, {
      status: 'FAILED',
      error: createScrubber(ctx.config.secrets)(errorMessage(error)),
    });
    throw error;
  }
}

/**
 * Idempotent guardian pause of the core or the registry: reads `paused()` first, keeps a cooldown
 * between attempts and writes every attempt to the `GuardianAction` audit log. The guardian key can
 * only pause and veto; unpausing is an admin (Safe) action.
 */
export async function guardianPause(
  ctx: WorkerContext,
  contract: 'core' | 'registry',
  reason: string,
): Promise<GuardianOutcome> {
  if (await isPaused(ctx.chain, contract)) return 'already';
  const target = contractAddress(ctx.chain, contract);
  if (await inCooldown(ctx, 'PAUSE', target, undefined)) return 'cooldown';
  if (ctx.config.dryRun) {
    ctx.logger.warn({ contract, reason }, 'dry-run: guardian pause not sent');
    return 'dry-run';
  }
  const write = {
    label: `pause ${contract}`,
    address: target,
    abi: contract === 'core' ? veriWorkCoreAbi : agentRegistryAbi,
    functionName: 'pause',
    args: [],
  };
  return (await act(ctx, 'PAUSE', target, write, reason)) === 'done' ? 'paused' : 'already';
}

/** Idempotent `vetoEpoch` (reads the epoch first; vetoed or swept epochs are left alone). */
export async function guardianVeto(
  ctx: WorkerContext,
  epochId: number,
  reason: string,
): Promise<GuardianOutcome> {
  const epoch = await readEpoch(ctx.chain, epochId);
  if (epoch.vetoed || epoch.swept) return 'already';
  const target = ctx.chain.deployment.core;
  if (await inCooldown(ctx, 'VETO_EPOCH', target, epochId)) return 'cooldown';
  if (ctx.config.dryRun) {
    ctx.logger.warn({ epochId, reason }, 'dry-run: guardian veto not sent');
    return 'dry-run';
  }
  const write = {
    label: 'vetoEpoch',
    address: target,
    abi: veriWorkCoreAbi,
    functionName: 'vetoEpoch',
    args: [BigInt(epochId)],
  };
  return (await act(ctx, 'VETO_EPOCH', target, write, reason, epochId)) === 'done'
    ? 'vetoed'
    : 'already';
}
