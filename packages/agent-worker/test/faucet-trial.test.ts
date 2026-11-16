import {
  castQaVote,
  createSubmission,
  freezeBatchForConsensus,
  getLatestGasTopUp,
  getTrialSession,
  listRecentAlerts,
  recordIdentityCheck,
  requestGasTopUp,
  submitReview,
  type PrismaClient,
} from '@veriwork/database';
import { encodeErrorResult, parseAbi } from 'viem';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { faucetRelayerJob } from '../src/gas/faucet-relayer';
import { trialConversionJob } from '../src/pipeline/trial-conversion';
import type { OwnedContext } from '../src/runtime/context';
import { databaseUrl, makeUser, useTestDatabase } from './helpers/db';
import { FakeRevert } from './helpers/fake-rpc';
import { CREW, publishedBatch } from './helpers/scenario';
import { addr, World } from './helpers/world';

const NOW = new Date('2026-11-16T14:00:00Z');
const prisma: PrismaClient = useTestDatabase();
let world: World;
let ctx: OwnedContext;

beforeEach(() => {
  world = new World(NOW);
  ctx = world.context(databaseUrl(), { db: prisma });
});

afterEach(async () => {
  await ctx.close();
});

describe('faucet relayer', () => {
  const USER = addr(0xf1);

  async function request(): Promise<string> {
    await makeUser(prisma, USER, USER, NOW);
    const result = await requestGasTopUp(prisma, {
      walletAddress: USER,
      goodIdRoot: USER,
      balanceWei: 10n ** 16n,
      now: NOW,
    });
    if (!result.ok) throw new Error(result.reason);
    return result.request.id;
  }

  it('re-checks the user, then sends Faucet.topWallet and marks the request SENT with its hash', async () => {
    await request();
    world.identity.verify(USER);
    expect(await faucetRelayerJob.run(ctx)).toMatchObject({ leased: 1, sent: 1 });
    const row = await getLatestGasTopUp(prisma, USER);
    expect(row).toMatchObject({
      status: 'SENT',
      txHash: world.chain.sentCalls('topWallet')[0]?.hash,
    });
    expect(world.faucet.state.topped).toEqual([USER]);
    expect(await faucetRelayerJob.run(ctx)).toMatchObject({ leased: 0 });
  });

  it('fails requests the re-check refuses', async () => {
    await request();
    expect(await faucetRelayerJob.run(ctx)).toMatchObject({ refused: 1 });
    expect((await getLatestGasTopUp(prisma, USER))?.failureReason).toBe('NOT_VERIFIED');
    world.identity.verify(addr(0xf2));
    await makeUser(prisma, addr(0xf2), addr(0xf2), NOW);
    await requestGasTopUp(prisma, {
      walletAddress: addr(0xf2),
      goodIdRoot: addr(0xf2),
      balanceWei: 0n,
      now: NOW,
    });
    world.chain.balances.set(addr(0xf2), 10n ** 18n);
    await faucetRelayerJob.run(ctx);
    expect((await getLatestGasTopUp(prisma, addr(0xf2)))?.failureReason).toBe(
      'BALANCE_ABOVE_THRESHOLD',
    );
  });

  it('records a faucet refusal and a reverting top-up as FAILED', async () => {
    await request();
    world.identity.verify(USER);
    world.faucet.state.refuse.add(USER);
    await faucetRelayerJob.run(ctx);
    expect((await getLatestGasTopUp(prisma, USER))?.failureReason).toBe('FAUCET_REFUSED');
    world.faucet.state.refuse.clear();
    world.clock.advance(60);
    await requestGasTopUp(prisma, {
      walletAddress: USER,
      goodIdRoot: USER,
      balanceWei: 0n,
      now: world.clock.now(),
    });
    const write = world.faucet.write.bind(world.faucet);
    world.faucet.write = (name, args, writeCtx) => {
      if (name === 'topWallet')
        throw new FakeRevert(
          encodeErrorResult({
            abi: parseAbi(['error Error(string)']),
            errorName: 'Error',
            args: ['max daily toppings'],
          }),
        );
      return write(name, args, writeCtx);
    };
    expect(await faucetRelayerJob.run(ctx)).toMatchObject({ failed: 1 });
    expect((await getLatestGasTopUp(prisma, USER))?.failureReason).toBe('REVERTED_WITH_REASON');
  });

  it('fails a request whose top-up the node refused to broadcast (hash stored first)', async () => {
    await request();
    world.identity.verify(USER);
    world.chain.nextSend = 'reject';
    expect(await faucetRelayerJob.run(ctx)).toMatchObject({ failed: 1 });
    expect(await getLatestGasTopUp(prisma, USER)).toMatchObject({
      status: 'FAILED',
      failureReason: 'BROADCAST_FAILED',
    });
    expect(world.faucet.state.topped).toEqual([]);
  });

  it('is not due in dry-run (leasing writes the database)', async () => {
    const dry = world.context(databaseUrl(), { db: prisma, dryRun: true });
    expect(await faucetRelayerJob.isDue(dry)).toBe(false);
    await dry.close();
  });
});

describe('trial conversion', () => {
  const TRIAL = addr(0x71);

  it('converts a verified trial wallet and alerts once about self-reviewed work in a frozen batch', async () => {
    const published = await publishedBatch(world, prisma, ctx, { items: 1 });
    await makeUser(prisma, TRIAL, null, NOW);
    const submitted = await createSubmission(prisma, {
      itemId: published.itemIds[0] ?? '',
      workerAddress: TRIAL,
      workerRoot: null,
      isTrial: true,
      correction: { labels: ['positive'] },
      now: NOW,
    });
    if (!submitted.ok) throw new Error(submitted.reason);
    // The reviewer is the same human as the trial wallet: its root is the reviewer's wallet.
    const reviewed = await submitReview(prisma, {
      submissionId: submitted.submission.id,
      reviewerAddress: CREW.reviewer,
      reviewerRoot: CREW.reviewer,
      score: 4,
      now: NOW,
    });
    if (!reviewed.ok) throw new Error(reviewed.reason);
    const voted = await castQaVote(prisma, {
      submissionId: submitted.submission.id,
      qaAddress: CREW.qa,
      qaRoot: CREW.qa,
      approve: true,
      now: NOW,
    });
    if (!voted.ok) throw new Error(voted.reason);
    const frozen = await freezeBatchForConsensus(prisma, published.batch.id, NOW);
    expect(frozen.ok).toBe(true);
    world.identity.verify(TRIAL, CREW.reviewer);
    await recordIdentityCheck(prisma, TRIAL, {
      root: CREW.reviewer,
      expiresAt: new Date(NOW.getTime() + 86_400_000),
      isFirstWindow: true,
      checkedAt: NOW,
    });
    expect(await trialConversionJob.run(ctx)).toMatchObject({ converted: 1 });
    expect((await getTrialSession(prisma, TRIAL))?.convertedRoot).toBe(CREW.reviewer);
    const alerts = await listRecentAlerts(prisma, {
      since: new Date(0),
      source: 'trial-conversion',
      severity: 'CRITICAL',
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.message).toContain(submitted.submission.id);
    world.clock.advance(2 * 3_600);
    expect(await trialConversionJob.run(ctx)).toMatchObject({ rechecked: 1 });
    expect(
      await listRecentAlerts(prisma, { since: new Date(0), source: 'trial-conversion' }),
    ).toHaveLength(1);
  });

  it('does not convert a wallet whose root no longer resolves on-chain, and dry-run writes nothing', async () => {
    await makeUser(prisma, TRIAL, TRIAL, NOW);
    await prisma.trialSession.create({ data: { walletAddress: TRIAL, tasksCompleted: 1 } });
    expect(await trialConversionJob.run(ctx)).toMatchObject({
      notVerifiedOnChain: 1,
      converted: 0,
    });
    world.identity.verify(TRIAL);
    const dry = world.context(databaseUrl(), { db: prisma, dryRun: true });
    await trialConversionJob.run(dry);
    await dry.close();
    expect((await getTrialSession(prisma, TRIAL))?.convertedToVerifiedAt).toBeNull();
  });
});
