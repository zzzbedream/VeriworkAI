import {
  addCampaignItems,
  createCampaign,
  ensureUser,
  getCampaign,
  listBatches,
  type CampaignRecord,
  type Prisma,
} from '@veriwork/database';
import {
  G_DOLLAR_PERMIT_DOMAIN,
  gDollarAbi,
  PERMIT_TYPES,
  SPONSOR_ROLE,
  veriWorkCoreAbi,
} from '@veriwork/shared';
import { getAbiItem, parseSignature, zeroAddress, type AbiEvent, type Hex } from 'viem';
import type { ChainSigner } from '../chain/clients';
import { readFresh } from '../chain/fresh-read';
import {
  gDollarAllowance,
  gDollarPermitNonce,
  hasCoreRole,
  readCampaign,
} from '../chain/contracts';
import { sendOrResume } from '../chain/tx-step';
import { recordReceipt } from '../indexer/receipt-events';
import { advanceBatch, type PublishReport } from '../pipeline/publish';
import { nowSeconds, type WorkerContext } from '../runtime/context';
import { required } from '../runtime/job';
import { DEMO_MAX_FEE_BPS, DEMO_PAY_TERMS, DEMO_QA_PROFILE } from './demo-campaigns';
import type { CampaignState, SeedState } from './inspect';

const PERMIT_TTL_SECONDS = 3_600;
/** Celo produces one block per second: a funding is found within this many blocks of its timestamp. */
const FUNDING_SEARCH_BLOCKS = 900n;
const campaignFundedEvent = getAbiItem({
  abi: veriWorkCoreAbi,
  name: 'CampaignFunded',
}) as AbiEvent;

function coreWrite(ctx: WorkerContext, functionName: string, args: readonly unknown[]) {
  return {
    label: functionName,
    address: ctx.chain.deployment.core,
    abi: veriWorkCoreAbi,
    functionName,
    args,
  };
}

/** The admin path: Pilot QA needs `allowPilot`, which only admin callers (this seeder) pass. */
async function ensureCampaign(
  ctx: WorkerContext,
  state: SeedState,
  campaign: CampaignState,
): Promise<CampaignRecord> {
  const record =
    campaign.record ??
    (await createCampaign(
      ctx.db,
      {
        sponsorAddress: state.operator,
        title: campaign.demo.title,
        description: campaign.demo.description,
        taskType: campaign.demo.taskType,
        instructions: campaign.demo.instructions,
        languages: campaign.demo.languages,
        requiredModuleId: null,
        rewardPerItemWei: DEMO_PAY_TERMS.rewardPerItemWei,
        reviewerFeeWei: DEMO_PAY_TERMS.reviewerFeeWei,
        qaFeeWei: DEMO_PAY_TERMS.qaFeeWei,
        itemsTarget: campaign.demo.items.length,
        qaProfile: DEMO_QA_PROFILE,
        onchainId: campaign.onchainId,
      },
      { allowPilot: true },
    ));
  if (campaign.items === 0) {
    const inputs = campaign.demo.items.map((item) => item.input as Prisma.InputJsonValue);
    const added = await addCampaignItems(ctx.db, record.id, inputs, { batchSize: inputs.length });
    if (!added.ok) throw new Error(`Could not add the demo items to ${record.id}: ${added.reason}`);
  }
  return record;
}

/** One transaction: an EIP-2612 permit signed off-chain, then `fundCampaignWithPermit`. */
async function fundWithPermit(
  ctx: WorkerContext,
  operator: ChainSigner,
  campaignId: Hex,
  amount: bigint,
): Promise<Hex | null> {
  const owner = operator.account.address;
  const nonce = await gDollarPermitNonce(ctx.chain, owner);
  const deadline = BigInt(nowSeconds(ctx) + PERMIT_TTL_SECONDS);
  const signature = await operator.wallet.signTypedData({
    account: operator.account,
    domain: {
      ...G_DOLLAR_PERMIT_DOMAIN,
      chainId: ctx.chain.chainId,
      verifyingContract: ctx.chain.deployment.gToken,
    },
    types: PERMIT_TYPES,
    primaryType: 'Permit',
    message: { owner, spender: ctx.chain.deployment.core, value: amount, nonce, deadline },
  });
  const { r, s, v, yParity } = parseSignature(signature);
  const outcome = await sendOrResume(operator, {
    write: coreWrite(ctx, 'fundCampaignWithPermit', [
      campaignId,
      amount,
      DEMO_MAX_FEE_BPS,
      deadline,
      Number(v ?? BigInt(yParity + 27)),
      r,
      s,
    ]),
    persistedHash: null,
  });
  return outcome.status === 'confirmed' ? outcome.hash : null;
}

/** Exact allowance (never unlimited), then `fundCampaign`. */
async function fundWithApprove(
  ctx: WorkerContext,
  operator: ChainSigner,
  campaignId: Hex,
  amount: bigint,
): Promise<Hex | null> {
  const allowance = await gDollarAllowance(
    ctx.chain,
    operator.account.address,
    ctx.chain.deployment.core,
  );
  if (allowance < amount) {
    await sendOrResume(operator, {
      write: {
        label: 'approve',
        address: ctx.chain.deployment.gToken,
        abi: gDollarAbi,
        functionName: 'approve',
        args: [ctx.chain.deployment.core, amount],
      },
      persistedHash: null,
    });
  }
  const outcome = await sendOrResume(operator, {
    write: coreWrite(ctx, 'fundCampaign', [campaignId, amount, DEMO_MAX_FEE_BPS]),
    persistedHash: null,
  });
  return outcome.status === 'confirmed' ? outcome.hash : null;
}

/** Stores the funding events of a campaign funded by an earlier, interrupted run. */
async function backfillFunding(ctx: WorkerContext, campaign: CampaignState): Promise<void> {
  const head = await ctx.chain.publicClient.getBlock({ blockTag: 'latest' });
  const age = head.timestamp - campaign.onchain.lastFundedAt;
  const around = head.number - (age > 0n ? age : 0n);
  const logs = await readFresh(() =>
    ctx.chain.publicClient.getLogs({
      address: ctx.chain.deployment.core,
      event: campaignFundedEvent,
      args: { campaignId: campaign.onchainId },
      fromBlock: around > FUNDING_SEARCH_BLOCKS ? around - FUNDING_SEARCH_BLOCKS : 0n,
      toBlock:
        around + FUNDING_SEARCH_BLOCKS < head.number ? around + FUNDING_SEARCH_BLOCKS : head.number,
    }),
  );
  for (const log of logs) {
    const hash = log.transactionHash;
    if (hash === null) continue;
    await recordReceipt(
      ctx,
      await readFresh(() => ctx.chain.publicClient.getTransactionReceipt({ hash })),
    );
  }
}

async function fundCampaign(
  ctx: WorkerContext,
  state: SeedState,
  campaign: CampaignState,
  record: CampaignRecord,
): Promise<void> {
  const operator = required(ctx.chain.operator, 'OPERATOR_PRIVATE_KEY');
  const onchain = await readCampaign(ctx.chain, campaign.onchainId);
  if (onchain.sponsor !== zeroAddress) {
    if (record.status === 'DRAFT') await backfillFunding(ctx, { ...campaign, onchain });
    return;
  }
  const amount = campaign.budget.funding;
  const hash = state.permitAvailable
    ? await fundWithPermit(ctx, operator, campaign.onchainId, amount)
    : await fundWithApprove(ctx, operator, campaign.onchainId, amount);
  if (hash !== null)
    await recordReceipt(
      ctx,
      await readFresh(() => ctx.chain.publicClient.getTransactionReceipt({ hash })),
    );
}

async function publishCampaign(
  ctx: WorkerContext,
  campaign: CampaignRecord,
  reviewWeeks: number,
): Promise<readonly PublishReport[]> {
  const current = (await getCampaign(ctx.db, campaign.id)) ?? campaign;
  const batches = await listBatches(ctx.db, {
    statuses: ['DRAFT', 'AI_DRAFTED'],
    campaignId: campaign.id,
  });
  const reports: PublishReport[] = [];
  for (const batch of batches) {
    reports.push(
      await advanceBatch(ctx, batch, current, { draftLimit: Number.MAX_SAFE_INTEGER, reviewWeeks }),
    );
  }
  return reports;
}

/**
 * Executes the seed plan, each step only when the state still needs it (so a re-run after a crash
 * at any step continues): database campaigns and items, SPONSOR_ROLE for the operator, funding
 * (permit, else exact approve), then `openBatch` -> signed drafts -> `markInHumanReview`.
 */
export async function executeSeed(
  ctx: WorkerContext,
  state: SeedState,
  options: { readonly reviewWeeks: number },
): Promise<readonly PublishReport[]> {
  const operator = required(ctx.chain.operator, 'OPERATOR_PRIVATE_KEY');
  await ensureUser(ctx.db, state.operator);
  const records: CampaignRecord[] = [];
  for (const campaign of state.campaigns) records.push(await ensureCampaign(ctx, state, campaign));
  if (!(await hasCoreRole(ctx.chain, SPONSOR_ROLE, state.operator))) {
    await sendOrResume(operator, {
      write: coreWrite(ctx, 'grantRole', [SPONSOR_ROLE, state.operator]),
      persistedHash: null,
    });
  }
  const reports: PublishReport[] = [];
  for (const [index, campaign] of state.campaigns.entries()) {
    const record = required(records[index], 'demo campaign');
    await fundCampaign(ctx, state, campaign, record);
    reports.push(...(await publishCampaign(ctx, record, options.reviewWeeks)));
  }
  return reports;
}
