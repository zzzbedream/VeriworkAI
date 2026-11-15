import { batchMaxPayout, hashCanonicalJson } from '@veriwork/shared';
import { describe, expect, it } from 'vitest';
import {
  buildBatchPayout,
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
import { castQaVote, submitReview } from '../src/repositories/reviews';
import { createSubmission } from '../src/repositories/submissions';
import {
  addr,
  hash32,
  LABEL_INPUT,
  makeCampaign,
  makePublishedBatch,
  makeUser,
  QA_FEE,
  REVIEWER_FEE,
  REWARD,
  seedAcceptedHistory,
  SPONSOR,
  useTestDatabase,
} from './helpers';

const prisma = useTestDatabase();
const PRICING = { rewardPerItemWei: REWARD, reviewerFeeWei: REVIEWER_FEE, qaFeeWei: QA_FEE };

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
      expect(batch.maxPayoutWei).toBe(batchMaxPayout(batch.items, PRICING));
    const items = await listBatchItems(prisma, result.batches[0]?.id ?? '');
    expect(items.map((item) => item.position)).toEqual(items.map((_, index) => index));
    expect(await addCampaignItems(prisma, campaign.id, [LABEL_INPUT])).toEqual({
      ok: false,
      reason: 'EXCEEDS_TARGET',
    });
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

  it('cancelling closes open submissions', async () => {
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
    expect((await prisma.taskSubmission.findFirstOrThrow()).status).toBe('REJECTED');
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

describe('consensus freeze and payout', () => {
  it('buildBatchPayout pays accepted work only: reward + reviewer fee + one QA fee per vote', () => {
    const batchId = hash32(7);
    const votes = [addr(1), addr(2), addr(3)].map((qa, index) => ({
      qaAddress: qa,
      qaRoot: index === 0 ? null : qa,
      approve: index !== 2,
    }));
    const accepted = [
      {
        itemId: 'b',
        position: 1,
        workerAddress: addr(9),
        isTrial: true,
        rewardWei: REWARD,
        reviewerAddress: addr(8),
        reviewerScore: 4,
        output: { labels: ['x'] },
        votes,
      },
      {
        itemId: 'a',
        position: 0,
        workerAddress: addr(9),
        isTrial: false,
        rewardWei: REWARD,
        reviewerAddress: null,
        reviewerScore: null,
        output: {},
        votes: [],
      },
    ];
    const payout = buildBatchPayout(
      batchId,
      { reviewerFeeWei: REVIEWER_FEE, qaFeeWei: QA_FEE },
      accepted,
    );
    expect(payout.payoutWei).toBe(REWARD * 2n + REVIEWER_FEE + QA_FEE * 3n);
    expect(payout.lines.every((line) => line.batchId === batchId)).toBe(true);
    expect(payout.lines.filter((line) => line.isTrial === true)).toHaveLength(1);
    expect(payout.acceptedItems).toBe(2);
    const reordered = buildBatchPayout(
      batchId,
      { reviewerFeeWei: REVIEWER_FEE, qaFeeWei: QA_FEE },
      [...accepted].reverse(),
    );
    expect(reordered.resultsHash).toBe(payout.resultsHash);
    const free = buildBatchPayout(batchId, { reviewerFeeWei: 0n, qaFeeWei: 0n }, accepted);
    expect(free.payoutWei).toBe(REWARD * 2n);
  });

  it('freezes, closes open work, pins payout + resultsHash and gates CONSENSUS_REACHED', async () => {
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
    expect(
      (await prisma.taskSubmission.findUniqueOrThrow({ where: { id: second.submission.id } }))
        .status,
    ).toBe('REJECTED');
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
    await createSubmission(prisma, {
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
      batches: { IN_HUMAN_REVIEW: 1 },
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
  });
});
