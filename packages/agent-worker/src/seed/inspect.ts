import {
  getCampaignByOnchainId,
  getCampaignProgress,
  listBatchItems,
  listBatches,
  type BatchRecord,
  type CampaignRecord,
} from '@veriwork/database';
import { OPERATOR_ROLE, SPONSOR_ROLE } from '@veriwork/shared';
import { domainSeparator, type Address, type Hex } from 'viem';
import {
  coreRoleAdmin,
  gDollarBalance,
  gDollarDomainSeparator,
  hasCoreRole,
  isPaused,
  readBatch,
  readCampaign,
  readPlatformFeeBps,
  type OnchainCampaign,
} from '../chain/contracts';
import { loadDemoDataset, type DemoCampaign } from '../demo/dataset';
import type { WorkerContext } from '../runtime/context';
import { demoBudget, demoCampaignOnchainId, type DemoBudget } from './demo-campaigns';

export interface BatchState {
  readonly batch: BatchRecord;
  readonly onchainStatus: number;
  readonly undrafted: number;
}

export interface CampaignState {
  readonly demo: DemoCampaign;
  readonly onchainId: Hex;
  readonly budget: DemoBudget;
  readonly record: CampaignRecord | null;
  readonly items: number;
  readonly batches: readonly BatchState[];
  readonly onchain: OnchainCampaign;
}

export interface SeedState {
  readonly chainId: number;
  readonly operator: Address;
  readonly agent: Address | null;
  readonly hasOperatorRole: boolean;
  readonly hasSponsorRole: boolean;
  readonly sponsorAdminIsOperator: boolean;
  readonly corePaused: boolean;
  readonly feeBps: number;
  readonly gDollarBalance: bigint;
  readonly celoBalance: bigint;
  /** The G$ `DOMAIN_SEPARATOR` equals the hardcoded permit domain: fund with one permit transaction. */
  readonly permitAvailable: boolean;
  readonly baseFeePerGas: bigint;
  readonly campaigns: readonly CampaignState[];
}

async function batchStates(
  ctx: WorkerContext,
  record: CampaignRecord | null,
): Promise<readonly BatchState[]> {
  if (record === null) return [];
  const batches = await listBatches(ctx.db, {
    statuses: ['DRAFT', 'AI_DRAFTED', 'IN_HUMAN_REVIEW', 'CONSENSUS_REACHED', 'SETTLED_ON_CHAIN'],
    campaignId: record.id,
  });
  const states: BatchState[] = [];
  for (const batch of batches) {
    const [onchain, items] = await Promise.all([
      readBatch(ctx.chain, batch.onchainId),
      listBatchItems(ctx.db, batch.id),
    ]);
    states.push({
      batch,
      onchainStatus: onchain.status,
      undrafted: items.filter((item) => item.aiDraftedAt === null).length,
    });
  }
  return states;
}

async function campaignState(
  ctx: WorkerContext,
  demo: DemoCampaign,
  feeBps: number,
): Promise<CampaignState> {
  const onchainId = demoCampaignOnchainId(ctx.chain.chainId, ctx.chain.deployment.core, demo.key);
  const record = await getCampaignByOnchainId(ctx.db, onchainId);
  const items = record === null ? 0 : (await getCampaignProgress(ctx.db, record.id)).items;
  return {
    demo,
    onchainId,
    budget: demoBudget(demo, feeBps),
    record,
    items,
    batches: await batchStates(ctx, record),
    onchain: await readCampaign(ctx.chain, onchainId),
  };
}

async function permitAvailable(ctx: WorkerContext): Promise<boolean> {
  const expected = domainSeparator({
    domain: {
      name: 'GoodDollar',
      version: '1',
      chainId: ctx.chain.chainId,
      verifyingContract: ctx.chain.deployment.gToken,
    },
  });
  try {
    return (await gDollarDomainSeparator(ctx.chain)) === expected;
  } catch {
    return false;
  }
}

/** Everything the demo seed depends on, read from the database and the chain (no writes). */
export async function inspectSeedState(ctx: WorkerContext, operator: Address): Promise<SeedState> {
  const { publicClient } = ctx.chain;
  const [
    hasOperatorRole,
    hasSponsorRole,
    sponsorAdmin,
    corePaused,
    feeBps,
    balance,
    celo,
    block,
    permit,
  ] = await Promise.all([
    hasCoreRole(ctx.chain, OPERATOR_ROLE, operator),
    hasCoreRole(ctx.chain, SPONSOR_ROLE, operator),
    coreRoleAdmin(ctx.chain, SPONSOR_ROLE),
    isPaused(ctx.chain, 'core'),
    readPlatformFeeBps(ctx.chain),
    gDollarBalance(ctx.chain, operator),
    publicClient.getBalance({ address: operator }),
    publicClient.getBlock({ blockTag: 'latest' }),
    permitAvailable(ctx),
  ]);
  const campaigns: CampaignState[] = [];
  for (const demo of loadDemoDataset().campaigns)
    campaigns.push(await campaignState(ctx, demo, feeBps));
  return {
    chainId: ctx.chain.chainId,
    operator,
    agent: ctx.chain.agent?.account.address ?? null,
    hasOperatorRole,
    hasSponsorRole,
    sponsorAdminIsOperator: sponsorAdmin.toLowerCase() === OPERATOR_ROLE.toLowerCase(),
    corePaused,
    feeBps,
    gDollarBalance: balance,
    celoBalance: celo,
    permitAvailable: permit,
    baseFeePerGas: block.baseFeePerGas ?? 0n,
    campaigns,
  };
}
