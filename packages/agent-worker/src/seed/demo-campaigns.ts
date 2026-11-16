import {
  batchMaxPayout,
  campaignFundingRequired,
  gDollars,
  PLATFORM_FEE_BPS,
  QA_PROFILES,
  type CampaignPayTerms,
  type QaProfileName,
} from '@veriwork/shared';
import { encodeAbiParameters, keccak256, type Address, type Hex } from 'viem';
import type { DemoCampaign } from '../demo/dataset';

/** Demo rates: 100 G$ per accepted item, 20 G$ per honest review, 10 G$ per honest QA vote. */
export const DEMO_REWARD_PER_ITEM = gDollars(100n);
export const DEMO_REVIEWER_FEE = gDollars(20n);
export const DEMO_QA_FEE = gDollars(10n);
/** Pilot QA (one voter): worker, reviewer and QA are still three distinct verified humans. */
export const DEMO_QA_PROFILE: QaProfileName = 'PILOT';
/** Most the operator (as sponsor) accepts as the campaign fee: today's 10% platform fee. */
export const DEMO_MAX_FEE_BPS = PLATFORM_FEE_BPS;

export const DEMO_PAY_TERMS: CampaignPayTerms = {
  rewardPerItemWei: DEMO_REWARD_PER_ITEM,
  reviewerFeeWei: DEMO_REVIEWER_FEE,
  qaFeeWei: DEMO_QA_FEE,
  ...QA_PROFILES[DEMO_QA_PROFILE],
};

/**
 * Deterministic campaign id per chain, core deployment and dataset campaign, so a re-run (or a
 * fresh database) finds the campaign it already funded on-chain.
 */
export function demoCampaignOnchainId(chainId: number, core: Address, key: string): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'string' }, { type: 'uint256' }, { type: 'address' }, { type: 'string' }],
      ['VeriWork demo campaign v1', BigInt(chainId), core, key],
    ),
  );
}

export interface DemoBudget {
  /** Worst-case payout of all the campaign's items (`openBatch` reserves it). */
  readonly maxPayout: bigint;
  /** Escrow the sponsor funds: worst case plus the fee on it. */
  readonly funding: bigint;
}

/** Budget by the shared worst-case formula: per item `reward + 2 × (reviewerFee + quorum × qaFee)`. */
export function demoBudget(campaign: DemoCampaign, feeBps: number): DemoBudget {
  const items = campaign.items.length;
  return {
    maxPayout: batchMaxPayout(items, DEMO_PAY_TERMS),
    funding: campaignFundingRequired(items, DEMO_PAY_TERMS, feeBps),
  };
}
