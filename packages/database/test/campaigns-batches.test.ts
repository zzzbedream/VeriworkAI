import { batchMaxPayout, hashCanonicalJson, itemMaxPayout, QA_PROFILES } from '@veriwork/shared';
import { describe, expect, it } from 'vitest';
import {
  freezeBatchForConsensus,
  getBatchPayout,
  getBatchReadiness,
} from '../src/repositories/batch-consensus';
import {
  getBatch,
  getBatchByOnchainId,
  listBatchItems,
  listBatches,
  recordAiDraft,
  recordBatchTx,
  transitionBatch,
} from '../src/repositories/batches';
import {
  addCampaignItems,
  exportAcceptedItems,
  getCampaignProgress,
} from '../src/repositories/campaign-items';
import {
  getCampaign,
  getCampaignByOnchainId,
  listCampaignsByStatus,
  listSponsorCampaigns,
  setCampaignStatus,
  syncCampaignFunding,
} from '../src/repositories/campaigns';
import { insertOnchainEvents } from '../src/repositories/onchain-events';
import { castQaVote } from '../src/repositories/qa-votes';
import { submitReview } from '../src/repositories/reviews';
import { createSubmission } from '../src/repositories/submissions';
import {
  addr,
  hash32,
  LABEL_INPUT,
  makeCampaign,
  makePublishedBatch,
  makeUser,
  PILOT_CAMPAIGN,
  QA_FEE,
  REVIEWER_FEE,
  REWARD,
  reviewAs,
  seedAcceptedHistory,
  SPONSOR,
  submitWork,
  useTestDatabase,
  voteAs,
} from './helpers';

const prisma = useTestDatabase();
const PRICING = { rewardPerItemWei: REWARD, reviewerFeeWei: REVIEWER_FEE, qaFeeWei: QA_FEE };
const STANDARD_TERMS = { ...PRICING, ...QA_PROFILES.STANDARD };
const PILOT_TERMS = { ...PRICING, ...QA_PROFILES.PILOT };

describe('campaigns', () => {
  it('creates, reads and lists campaigns with exact wei amounts', async () => {
    const campaign = await makeCampaign(prisma, {
      onchainId: hash32(0xabc).toUpperCase().replace('0X', '0x'),
    });
    expect(campaign).toMatchObject({
      onchainId: hash32(0xabc),
      status: 'DRAFT',
      rewardPerItemWei: REWARD,
      fundedWei: 0n,
      qaProfile: 'STANDARD',
      qaQuorum: 3,
      qaApprovalsRequired: 2,
    });
    expect((await getCampaign(prisma, campaign.id))?.title).toBe('Sentiment labels');
    expect((await getCampaignByOnchainId(prisma, hash32(0xabc)))?.id).toBe(campaign.id);
    expect(await getCampaign(prisma, '00000000-0000-4000-8000-000000000000')).toBeNull();
    expect(await getCampaignByOnchainId(prisma, hash32(1))).toBeNull();
    expect((await listSponsorCampaigns(prisma, SPONSOR)).map((c) => c.id)).toEqual([campaign.id]);
    expect(await listCampaignsByStatus(prisma, ['FUNDED'])).toEqual([]);
    await expect(makeCampaign(prisma, { itemsTarget: 0 })).rejects.toThrow(RangeError);
    await expect(makeCampaign(prisma, { onchainId: '0x1234' })).rejects.toThrow(TypeError);
  });

  it('changes status with compare-and-set', async () => {
    const campaign = await makeCampaign(prisma);
    expect((await setCampaignStatus(prisma, campaign.id, 'FUNDED', ['DRAFT']))?.status).toBe(
      'FUNDED',
    );
    expect(await setCampaignStatus(prisma, campaign.id, 'ACTIVE', ['DRAFT'])).toBeNull();
    expect((await listCampaignsByStatus(prisma, ['FUNDED', 'ACTIVE'])).length).toBe(1);
  });

  it('syncs funding from indexed CampaignFunded / CampaignWithdrawn events (idempotent)', async () => {
    const campaign = await makeCampaign(prisma);
    const event = (logIndex: number, eventName: string, args: Record<string, unknown>) => ({
      chainId: 42220,
      contractAddress: addr(0xc0),
      eventName,
      blockNumber: BigInt(100 + logIndex),
      blockTimestamp: new Date('2026-11-16T13:00:00Z'),
      txHash: hash32(0x900 + logIndex),
      logIndex,
      args,
    });
    const events = [
      event(1, 'CampaignFunded', {
        campaignId: campaign.onchainId,
        sponsor: SPONSOR,
        received: 1_000n * 10n ** 18n,
        feeBps: 1000,
      }),
      event(2, 'CampaignFunded', {
        campaignId: campaign.onchainId,
        sponsor: SPONSOR,
        received: 500n * 10n ** 18n,
        feeBps: 1000,
      }),
      event(3, 'CampaignWithdrawn', {
        campaignId: campaign.onchainId,
        sponsor: SPONSOR,
        amount: 200n * 10n ** 18n,
      }),
    ];
    await insertOnchainEvents(prisma, events);
    await insertOnchainEvents(prisma, events);
    // A look-alike event from another contract is ignored when the core address is given.
    await insertOnchainEvents(prisma, [
      {
        ...event(4, 'CampaignFunded', { campaignId: campaign.onchainId, received: 9n }),
        contractAddress: addr(0xee),
      },
    ]);
    const synced = await syncCampaignFunding(prisma, {
      chainId: 42220,
      onchainId: campaign.onchainId,
      coreAddress: addr(0xc0),
    });
    expect(synced).toMatchObject({
      fundedWei: 1_300n * 10n ** 18n,
      fundTxHash: hash32(0x902),
      status: 'FUNDED',
    });
    expect(await syncCampaignFunding(prisma, { chainId: 42220, onchainId: hash32(5) })).toBeNull();
    const empty = await makeCampaign(prisma, { title: 'other' });
    expect(
      await syncCampaignFunding(prisma, { chainId: 42220, onchainId: empty.onchainId }),
    ).toMatchObject({ fundedWei: 0n, status: 'DRAFT' });
  });
});

describe('campaign items (B2B upload -> DRAFT batches)', () => {
  it('chunks items into DRAFT batches with their reservation', async () => {
    const campaign = await makeCampaign(prisma, { itemsTarget: 5 });
    const result = await addCampaignItems(
      prisma,
      campaign.id,
      Array.from({ length: 5 }, () => LABEL_INPUT),
      { batchSize: 2 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.batches.map((batch) => batch.items).sort()).toEqual([1, 2, 2]);
    for (const batch of result.batches)
      expect(batch.maxPayoutWei).toBe(batchMaxPayout(batch.items, STANDARD_TERMS));
    const items = await listBatchItems(prisma, result.batches[0]?.id ?? '');
    expect(items.map((item) => item.position)).toEqual(items.map((_, index) => index));
    expect(await addCampaignItems(prisma, campaign.id, [LABEL_INPUT])).toEqual({
      ok: false,
      reason: 'EXCEEDS_TARGET',
    });
  });

  it('Pilot (one unchecked vote) needs the admin-only allowPilot option; by default it is refused', async () => {
    const standard = await makeCampaign(prisma);
    expect(standard).toMatchObject({ qaProfile: 'STANDARD', qaQuorum: 3, qaApprovalsRequired: 2 });
    await expect(makeCampaign(prisma, { qaProfile: 'PILOT' })).rejects.toThrow(/allowPilot/);
    await expect(makeCampaign(prisma, { qaProfile: 'PILOT', allowPilot: false })).rejects.toThrow(
      /allowPilot/,
    );
    // The option only permits Pilot: a campaign is still Standard unless Pilot is asked for.
    expect(await makeCampaign(prisma, { allowPilot: true })).toMatchObject({
      qaProfile: 'STANDARD',
    });
    const pilot = await makeCampaign(prisma, PILOT_CAMPAIGN);
    expect(pilot).toMatchObject({ qaProfile: 'PILOT', qaQuorum: 1, qaApprovalsRequired: 1 });
    // A refused campaign writes nothing.
    expect(await prisma.campaign.count()).toBe(3);
  });

  it('a Pilot campaign reserves its own worst case; the profile is one of the allowed pairs', async () => {
    const pilot = await makeCampaign(prisma, PILOT_CAMPAIGN);
    expect(pilot).toMatchObject({ qaProfile: 'PILOT', qaQuorum: 1, qaApprovalsRequired: 1 });
    const result = await addCampaignItems(prisma, pilot.id, [LABEL_INPUT, LABEL_INPUT]);
    expect(result.ok && result.batches[0]?.maxPayoutWei).toBe(batchMaxPayout(2, PILOT_TERMS));
    // 2 items x (100 + 2 x (10 + 1 x 5)) G$ for Pilot vs 2 x (100 + 2 x (10 + 3 x 5)) for Standard.
    expect(batchMaxPayout(2, PILOT_TERMS)).toBe(260n * 10n ** 18n);
    expect(batchMaxPayout(2, STANDARD_TERMS)).toBe(300n * 10n ** 18n);
    await expect(
      prisma.campaign.update({ where: { id: pilot.id }, data: { qaQuorum: 3 } }),
    ).rejects.toThrow(/Campaign_qaProfile_valid/);
  });

  it('never exceeds itemsTarget under concurrent uploads', async () => {
    const campaign = await makeCampaign(prisma, { itemsTarget: 4 });
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        addCampaignItems(prisma, campaign.id, [LABEL_INPUT, LABEL_INPUT]),
      ),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(2);
    expect(await prisma.taskItem.count()).toBe(4);
  });

  it('refuses unknown, closed and empty uploads', async () => {
    const campaign = await makeCampaign(prisma);
    expect(
      await addCampaignItems(prisma, '00000000-0000-4000-8000-000000000000', [LABEL_INPUT]),
    ).toEqual({ ok: false, reason: 'NOT_FOUND' });
    expect(await addCampaignItems(prisma, campaign.id, [])).toEqual({ ok: false, reason: 'EMPTY' });
    await setCampaignStatus(prisma, campaign.id, 'CANCELLED');
    expect(await addCampaignItems(prisma, campaign.id, [LABEL_INPUT])).toEqual({
      ok: false,
      reason: 'CAMPAIGN_CLOSED',
    });
    await expect(
      addCampaignItems(prisma, campaign.id, [LABEL_INPUT], { batchSize: 0 }),
    ).rejects.toThrow(RangeError);
  });
});

describe('batch state machine', () => {
  it('follows the on-chain transitions with compare-and-set and tx hashes', async () => {
    const campaign = await makeCampaign(prisma);
    const added = await addCampaignItems(prisma, campaign.id, [LABEL_INPUT]);
    const draft = added.ok ? added.batches[0] : undefined;
    if (draft === undefined) throw new Error('no batch');
    expect(
      (await listBatches(prisma, { statuses: ['DRAFT'], campaignStatuses: ['DRAFT'] })).map(
        (b) => b.id,
      ),
    ).toEqual([draft.id]);
    expect(
      await listBatches(prisma, { statuses: ['DRAFT'], campaignStatuses: ['FUNDED'] }),
    ).toEqual([]);
    await recordBatchTx(prisma, draft.id, 'open', hash32(0x10));
    const opened = await transitionBatch(prisma, draft.id, 'DRAFT', 'AI_DRAFTED');
    expect(opened).toMatchObject({ status: 'AI_DRAFTED', openTxHash: hash32(0x10) });
    expect(await transitionBatch(prisma, draft.id, 'DRAFT', 'AI_DRAFTED')).toBeNull();
    await expect(
      transitionBatch(prisma, draft.id, 'AI_DRAFTED', 'SETTLED_ON_CHAIN'),
    ).rejects.toThrow(/Invalid batch transition/);
    const deadlineAt = new Date('2026-11-21T12:00:00Z');
    const published = await transitionBatch(prisma, draft.id, 'AI_DRAFTED', 'IN_HUMAN_REVIEW', {
      txHash: hash32(0x11),
      deadlineAt,
    });
    expect(published).toMatchObject({
      status: 'IN_HUMAN_REVIEW',
      reviewTxHash: hash32(0x11),
      deadlineAt,
    });
    expect(published?.publishedAt).toBeInstanceOf(Date);
    await expect(
      transitionBatch(prisma, draft.id, 'IN_HUMAN_REVIEW', 'CONSENSUS_REACHED'),
    ).rejects.toThrow(/frozen/);
    expect((await getBatchByOnchainId(prisma, draft.onchainId))?.id).toBe(draft.id);
    expect(await getBatch(prisma, '00000000-0000-4000-8000-000000000000')).toBeNull();
    expect(
      await transitionBatch(prisma, '00000000-0000-4000-8000-000000000000', 'DRAFT', 'CANCELLED'),
    ).toBeNull();
    for (const kind of ['review', 'consensus', 'settle', 'cancel'] as const)
      await recordBatchTx(prisma, draft.id, kind, hash32(0x20));
    expect(await getBatch(prisma, draft.id)).toMatchObject({
      consensusTxHash: hash32(0x20),
      settleTxHash: hash32(0x20),
      cancelTxHash: hash32(0x20),
    });
  });

  it('cancelling voids open submissions (a cancelled batch pays nobody)', async () => {
    const { batch, itemIds } = await makePublishedBatch(prisma, { items: 1 });
    await makeUser(prisma, addr(0x10), addr(0x11));
    await createSubmission(prisma, {
      itemId: itemIds[0] ?? '',
      workerAddress: addr(0x10),
      workerRoot: addr(0x11),
      isTrial: false,
      correction: {},
    });
    const cancelled = await transitionBatch(prisma, batch.id, 'IN_HUMAN_REVIEW', 'CANCELLED', {
      txHash: hash32(0x12),
    });
    expect(cancelled).toMatchObject({ status: 'CANCELLED', cancelTxHash: hash32(0x12) });
    expect(await prisma.taskSubmission.findFirstOrThrow()).toMatchObject({
      status: 'VOIDED',
      voidReason: 'BATCH_CANCELLED',
      activeItemId: null,
      qaPassed: null,
    });
  });

  it('stores AI drafts only when the hash matches, and only before the batch is published', async () => {
    const campaign = await makeCampaign(prisma);
    const added = await addCampaignItems(prisma, campaign.id, [LABEL_INPUT]);
    const draftBatch = added.ok ? added.batches[0] : undefined;
    if (draftBatch === undefined) throw new Error('no batch');
    const [stored] = await listBatchItems(prisma, draftBatch.id);
    const itemId = stored?.id ?? '';
    const output = { labels: ['positive'] };
    const draft = {
      agentAddress: addr(0xa1),
      model: 'claude-opus-5-5',
      output,
      signature: '0x' + '11'.repeat(65),
    };
    await expect(
      recordAiDraft(prisma, itemId, { ...draft, outputHash: hash32(1) }),
    ).rejects.toThrow(/mismatch/);
    expect(
      await recordAiDraft(prisma, itemId, { ...draft, outputHash: hashCanonicalJson(output) }),
    ).toBe(true);
    const [item] = await listBatchItems(prisma, draftBatch.id);
    expect(item).toMatchObject({
      aiAgentAddress: addr(0xa1),
      aiModel: 'claude-opus-5-5',
      aiOutputHash: hashCanonicalJson(output),
      aiInitialOutput: output,
    });
    await transitionBatch(prisma, draftBatch.id, 'DRAFT', 'AI_DRAFTED');
    await transitionBatch(prisma, draftBatch.id, 'AI_DRAFTED', 'IN_HUMAN_REVIEW');
    const changed = { labels: ['negative'] };
    expect(
      await recordAiDraft(prisma, itemId, {
        ...draft,
        output: changed,
        outputHash: hashCanonicalJson(changed),
      }),
    ).toBe(false);
    expect((await listBatchItems(prisma, draftBatch.id))[0]?.aiInitialOutput).toEqual(output);
  });
});

describe('pay rules through the real pipeline', () => {
  // Each attempt of an item is decided by other people: whoever took part in an item's first attempt
  // may not decide (or work on) its retry.
  const REVIEWERS = [addr(0x20), addr(0x21)];
  const QA_PANELS = [
    [addr(0x31), addr(0x32), addr(0x33)],
    [addr(0x34), addr(0x35), addr(0x36)],
  ];
  const WORKERS = [addr(0x10), addr(0x12), addr(0x14)];

  async function actors(): Promise<void> {
    for (const reviewer of REVIEWERS) await seedAcceptedHistory(prisma, reviewer, 10);
    for (const qa of QA_PANELS.flat()) await seedAcceptedHistory(prisma, qa, 25);
    for (const [index, worker] of WORKERS.entries())
      await makeUser(prisma, worker, addr(0x80 + index));
  }

  /** Submit, review and QA-vote one attempt (attempt 1 or 2: its own reviewer and QA panel). */
  async function attempt(
    itemId: string,
    workerIndex: number,
    score: number,
    approvals: readonly boolean[],
  ): Promise<void> {
    const worker = WORKERS[workerIndex] ?? '';
    const submission = await submitWork(prisma, itemId, worker, addr(0x80 + workerIndex));
    const panel = submission.attempt - 1;
    await reviewAs(prisma, submission.id, REVIEWERS[panel] ?? '', score);
    await voteAs(prisma, submission.id, QA_PANELS[panel] ?? [], approvals);
  }

  it('pays every decision that matches the verdict, rejected attempts included, within the reservation', async () => {
    const { batch, itemIds } = await makePublishedBatch(prisma, { items: 2 });
    await actors();
    const [first = '', second = ''] = itemIds;
    // Item 0, the worst case: an honest rejection, then an honest acceptance (everyone aligned).
    await attempt(first, 0, 1, [false, false, false]);
    await attempt(first, 1, 5, [true, true, true]);
    // Item 1: a rubber-stamping review then a contrarian one, a dissenting voter each time.
    await attempt(second, 0, 4, [false, false, true]);
    await attempt(second, 2, 2, [true, true, false]);
    const readiness = await getBatchReadiness(prisma, batch.id);
    expect(readiness).toMatchObject({ acceptedItems: 2, closedItems: 0, ready: true });
    const frozen = await freezeBatchForConsensus(prisma, batch.id);
    if (!frozen.ok) throw new Error(frozen.reason);
    const byAccount = new Map<string, bigint>();
    for (const line of frozen.payout.lines)
      byAccount.set(line.account, (byAccount.get(line.account) ?? 0n) + line.amount);
    const [first3 = [], second3 = []] = QA_PANELS;
    expect(Object.fromEntries(byAccount)).toEqual({
      // Item 0: both reviews aligned; item 1: neither (rubber stamp, then contrarian).
      [REVIEWERS[0] ?? '']: REVIEWER_FEE,
      [REVIEWERS[1] ?? '']: REVIEWER_FEE,
      // Attempt-1 panel: all aligned on item 0, the dissenter (third voter) unpaid on item 1.
      [first3[0] ?? '']: QA_FEE * 2n,
      [first3[1] ?? '']: QA_FEE * 2n,
      [first3[2] ?? '']: QA_FEE,
      [second3[0] ?? '']: QA_FEE * 2n,
      [second3[1] ?? '']: QA_FEE * 2n,
      [second3[2] ?? '']: QA_FEE,
      [WORKERS[1] ?? '']: REWARD,
      [WORKERS[2] ?? '']: REWARD,
    });
    expect(frozen.payout.payoutWei).toBe(REWARD * 2n + REVIEWER_FEE * 2n + QA_FEE * 10n);
    expect(frozen.payout).toMatchObject({ acceptedItems: 2, finalizedSubmissions: 4 });
    expect(frozen.payout.payoutWei <= batch.maxPayoutWei).toBe(true);
    expect(batch.maxPayoutWei).toBe(itemMaxPayout(STANDARD_TERMS) * 2n);
    expect((await getBatchPayout(prisma, batch.id))?.resultsHash).toBe(frozen.payout.resultsHash);
  });

  it('a batch is ready once every item is accepted or closed; open work waits for the deadline', async () => {
    const { batch, itemIds } = await makePublishedBatch(prisma, { items: 2 });
    await actors();
    const [first = '', second = ''] = itemIds;
    await attempt(first, 0, 2, [false, false, true]);
    await attempt(first, 1, 2, [false, false, false]);
    const pending = await submitWork(prisma, second, WORKERS[2] ?? '', addr(0x82));
    expect(await getBatchReadiness(prisma, batch.id)).toMatchObject({
      totalItems: 2,
      acceptedItems: 0,
      closedItems: 1,
      openSubmissions: 1,
      ready: false,
    });
    await reviewAs(prisma, pending.id, REVIEWERS[0] ?? '', 4);
    await voteAs(prisma, pending.id, QA_PANELS[0] ?? [], [true, true, false]);
    expect(await getBatchReadiness(prisma, batch.id)).toMatchObject({
      acceptedItems: 1,
      closedItems: 1,
      openSubmissions: 0,
      ready: true,
    });
    const frozen = await freezeBatchForConsensus(prisma, batch.id);
    // Closed item: both reviews and the 5 aligned rejections are paid, no worker reward.
    expect(frozen.ok && frozen.payout.payoutWei).toBe(
      REVIEWER_FEE * 3n + QA_FEE * 5n + REWARD + QA_FEE * 2n,
    );
  });
});

describe('consensus freeze and payout', () => {
  it('freezes, voids open work, pins payout + resultsHash and gates CONSENSUS_REACHED', async () => {
    const { batch, itemIds } = await makePublishedBatch(prisma, { items: 2 });
    const reviewer = addr(0x20);
    const qas = [addr(0x31), addr(0x32), addr(0x33)];
    await seedAcceptedHistory(prisma, reviewer, 10);
    for (const qa of qas) await seedAcceptedHistory(prisma, qa, 25);
    await makeUser(prisma, addr(0x10), addr(0x11));
    const first = await createSubmission(prisma, {
      itemId: itemIds[0] ?? '',
      workerAddress: addr(0x10),
      workerRoot: addr(0x11),
      isTrial: false,
      correction: { labels: ['positive'] },
    });
    const second = await createSubmission(prisma, {
      itemId: itemIds[1] ?? '',
      workerAddress: addr(0x10),
      workerRoot: addr(0x11),
      isTrial: false,
      correction: { labels: ['negative'] },
    });
    if (!first.ok || !second.ok) throw new Error('submit failed');
    await submitReview(prisma, {
      submissionId: first.submission.id,
      reviewerAddress: reviewer,
      reviewerRoot: reviewer,
      score: 5,
    });
    for (const qa of qas)
      await castQaVote(prisma, {
        submissionId: first.submission.id,
        qaAddress: qa,
        qaRoot: qa,
        approve: true,
      });
    const readiness = await getBatchReadiness(prisma, batch.id);
    expect(readiness).toMatchObject({
      totalItems: 2,
      acceptedItems: 1,
      closedItems: 0,
      openSubmissions: 1,
      deadlinePassed: false,
      frozen: false,
      ready: false,
    });
    const later = new Date(Date.now() + 10 * 86_400_000);
    await prisma.taskBatch.update({ where: { id: batch.id }, data: { deadlineAt: new Date() } });
    expect((await getBatchReadiness(prisma, batch.id, later))?.ready).toBe(true);
    const frozen = await freezeBatchForConsensus(prisma, batch.id);
    expect(frozen.ok).toBe(true);
    if (!frozen.ok) return;
    expect(frozen.payout.payoutWei).toBe(REWARD + REVIEWER_FEE + QA_FEE * 3n);
    expect(frozen.batch).toMatchObject({
      payoutWei: frozen.payout.payoutWei,
      resultsHash: frozen.payout.resultsHash,
    });
    // Still open at the freeze: voided, distinguishable from a QA rejection, and paid to nobody.
    expect(
      await prisma.taskSubmission.findUniqueOrThrow({ where: { id: second.submission.id } }),
    ).toMatchObject({ status: 'VOIDED', voidReason: 'BATCH_FROZEN', qaPassed: null });
    expect(frozen.payout.lines.some((line) => line.account === addr(0x10))).toBe(true);
    expect(frozen.payout.finalizedSubmissions).toBe(1);
    expect((await getBatchReadiness(prisma, batch.id))?.frozen).toBe(true);
    const again = await freezeBatchForConsensus(prisma, batch.id);
    expect(again.ok && again.payout.resultsHash).toBe(frozen.payout.resultsHash);
    expect((await getBatchPayout(prisma, batch.id))?.payoutWei).toBe(frozen.payout.payoutWei);
    await expect(
      transitionBatch(prisma, batch.id, 'IN_HUMAN_REVIEW', 'CONSENSUS_REACHED', { payoutWei: 1n }),
    ).rejects.toThrow(/payout/);
    await expect(
      transitionBatch(prisma, batch.id, 'IN_HUMAN_REVIEW', 'CONSENSUS_REACHED', {
        resultsHash: hash32(1),
      }),
    ).rejects.toThrow(/resultsHash/);
    const consensus = await transitionBatch(
      prisma,
      batch.id,
      'IN_HUMAN_REVIEW',
      'CONSENSUS_REACHED',
      {
        payoutWei: frozen.payout.payoutWei,
        resultsHash: frozen.payout.resultsHash,
        txHash: hash32(0x33),
      },
    );
    expect(consensus).toMatchObject({ status: 'CONSENSUS_REACHED', consensusTxHash: hash32(0x33) });
    await expect(
      transitionBatch(prisma, batch.id, 'CONSENSUS_REACHED', 'SETTLED_ON_CHAIN'),
    ).rejects.toThrow(/epoch/);
    expect(await freezeBatchForConsensus(prisma, batch.id)).toEqual({
      ok: false,
      reason: 'NOT_IN_HUMAN_REVIEW',
    });
    expect(await freezeBatchForConsensus(prisma, '00000000-0000-4000-8000-000000000000')).toEqual({
      ok: false,
      reason: 'NOT_FOUND',
    });
    expect(await getBatchReadiness(prisma, '00000000-0000-4000-8000-000000000000')).toBeNull();
    expect(await getBatchPayout(prisma, '00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('a frozen payout is never overwritten: a re-run that no longer produces it throws', async () => {
    const { batch, itemIds } = await makePublishedBatch(prisma, { items: 1 });
    await seedAcceptedHistory(prisma, addr(0x20), 10);
    const qas = [addr(0x31), addr(0x32), addr(0x33)];
    for (const qa of qas) await seedAcceptedHistory(prisma, qa, 25);
    await makeUser(prisma, addr(0x10), addr(0x11));
    const submission = await submitWork(prisma, itemIds[0] ?? '', addr(0x10), addr(0x11));
    await reviewAs(prisma, submission.id, addr(0x20), 4);
    await voteAs(prisma, submission.id, qas, [true, true, true]);
    const frozen = await freezeBatchForConsensus(prisma, batch.id);
    if (!frozen.ok) throw new Error(frozen.reason);
    // Re-runs return the pinned values, exactly (no stray fields).
    const again = await freezeBatchForConsensus(prisma, batch.id);
    expect(again).toEqual(frozen);
    // A payout pinned by other rules (e.g. frozen before an upgrade) differs from what the rows produce.
    await prisma.taskBatch.update({ where: { id: batch.id }, data: { payoutWei: '1' } });
    await expect(freezeBatchForConsensus(prisma, batch.id)).rejects.toThrow(/frozen payout/);
    await prisma.taskBatch.update({
      where: { id: batch.id },
      data: { payoutWei: frozen.payout.payoutWei.toString(), resultsHash: hash32(7) },
    });
    await expect(freezeBatchForConsensus(prisma, batch.id)).rejects.toThrow(/frozen payout/);
    expect(await getBatch(prisma, batch.id)).toMatchObject({
      payoutWei: frozen.payout.payoutWei,
      resultsHash: hash32(7),
    });
  });

  it('progress and export of the accepted dataset', async () => {
    const { campaign, itemIds } = await makePublishedBatch(prisma, { items: 2 });
    const reviewer = addr(0x20);
    const qas = [addr(0x31), addr(0x32), addr(0x33)];
    await seedAcceptedHistory(prisma, reviewer, 10);
    for (const qa of qas) await seedAcceptedHistory(prisma, qa, 25);
    await makeUser(prisma, addr(0x10), addr(0x11));
    const submitted = await createSubmission(prisma, {
      itemId: itemIds[0] ?? '',
      workerAddress: addr(0x10),
      workerRoot: addr(0x11),
      isTrial: false,
      correction: { labels: ['negative'] },
    });
    if (!submitted.ok) throw new Error('submit failed');
    await submitReview(prisma, {
      submissionId: submitted.submission.id,
      reviewerAddress: reviewer,
      reviewerRoot: reviewer,
      score: 4,
    });
    for (const [index, qa] of qas.entries()) {
      await castQaVote(prisma, {
        submissionId: submitted.submission.id,
        qaAddress: qa,
        qaRoot: qa,
        approve: index < 2,
        reason: 'n/a',
      });
    }
    const open = await createSubmission(prisma, {
      itemId: itemIds[1] ?? '',
      workerAddress: addr(0x10),
      workerRoot: addr(0x11),
      isTrial: false,
      correction: {},
    });
    expect(await getCampaignProgress(prisma, campaign.id)).toEqual({
      items: 2,
      drafted: 0,
      accepted: 1,
      rejected: 0,
      inReview: 1,
      voided: 0,
      closedItems: 0,
      batches: { IN_HUMAN_REVIEW: 1 },
    });
    // Accepted work is not exported before its batch's payout is committed (consensus): a batch can
    // still be cancelled, which releases the whole reservation.
    expect(await exportAcceptedItems(prisma, campaign.id)).toEqual([]);
    expect(open.ok).toBe(true);
    const batchId = open.ok ? open.submission.batchId : '';
    const frozen = await freezeBatchForConsensus(prisma, batchId);
    if (!frozen.ok) throw new Error(frozen.reason);
    await transitionBatch(prisma, batchId, 'IN_HUMAN_REVIEW', 'CONSENSUS_REACHED', {
      payoutWei: frozen.payout.payoutWei,
      resultsHash: frozen.payout.resultsHash,
    });
    const rows = await exportAcceptedItems(prisma, campaign.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      itemId: itemIds[0],
      position: 0,
      finalOutput: { labels: ['negative'] },
      reviewerScore: 4,
      qaApprovals: 2,
    });
    // Cancelled after all (operator only): nothing of that batch is exported any more.
    await transitionBatch(prisma, batchId, 'CONSENSUS_REACHED', 'CANCELLED');
    expect(await exportAcceptedItems(prisma, campaign.id)).toEqual([]);
    expect(await getCampaignProgress(prisma, campaign.id)).toMatchObject({
      accepted: 1,
      inReview: 0,
      voided: 1,
      batches: { CANCELLED: 1 },
    });
  });
});
