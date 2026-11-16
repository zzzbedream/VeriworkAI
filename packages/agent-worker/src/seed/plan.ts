import {
  CELO_BASE_FEE_FLOOR_WEI,
  DEFAULT_MAX_PRIORITY_FEE_PER_GAS_WEI,
  formatGDollar,
  OnchainBatchStatus,
  OPERATOR_ROLE,
  SPONSOR_ROLE,
  workerFeeOverrides,
} from '@veriwork/shared';
import { formatEther, zeroAddress } from 'viem';
import { DEMO_MAX_FEE_BPS, DEMO_PAY_TERMS } from './demo-campaigns';
import type { CampaignState, SeedState } from './inspect';

export type StepStatus = 'done' | 'todo';
export type StepKind = 'db' | 'tx' | 'sign';

export interface PlanStep {
  readonly kind: StepKind;
  readonly status: StepStatus;
  readonly description: string;
  /** Upper-bound gas of a transaction step (`eth_estimateGas` varies with G$'s Superfluid paths). */
  readonly gas?: bigint;
}

export interface SeedPlan {
  readonly steps: readonly PlanStep[];
  /** Preconditions that block the seed (it refuses to send anything while any is listed). */
  readonly problems: readonly string[];
  readonly gDollarNeeded: bigint;
  readonly transactions: number;
  readonly gas: bigint;
  /** CELO at the current base fee + tip, and at the explicit `maxFeePerGas` cap. */
  readonly celoTypical: bigint;
  readonly celoMax: bigint;
}

/** Conservative gas per call (G$ transfers cost 99k–252k gas; permit ~90k). */
export const SEED_GAS = {
  grantRole: 80_000n,
  approve: 90_000n,
  fundCampaign: 380_000n,
  fundCampaignWithPermit: 460_000n,
  openBatch: 160_000n,
  markInHumanReview: 70_000n,
} as const;

const g = (wei: bigint): string => formatGDollar(wei);
const short = (hex: string): string => `${hex.slice(0, 10)}…${hex.slice(-6)}`;

function tx(status: StepStatus, description: string, gas: bigint): PlanStep {
  return { kind: 'tx', status, description, gas };
}

function dbSteps(state: CampaignState): readonly PlanStep[] {
  const { demo, budget } = state;
  const profile = `Pilot QA ${DEMO_PAY_TERMS.qaQuorum}/${DEMO_PAY_TERMS.qaApprovalsRequired}`;
  const rates = `${g(DEMO_PAY_TERMS.rewardPerItemWei)} / ${g(DEMO_PAY_TERMS.reviewerFeeWei)} / ${g(DEMO_PAY_TERMS.qaFeeWei)}`;
  return [
    {
      kind: 'db',
      status: state.record === null ? 'todo' : 'done',
      description: `createCampaign "${demo.title}" (admin path, allowPilot: ${profile}, ${rates}, sponsor = operator, onchainId ${short(state.onchainId)})`,
    },
    {
      kind: 'db',
      status: state.items >= demo.items.length ? 'done' : 'todo',
      description: `addCampaignItems: ${demo.items.length} ${demo.taskType} items in 1 DRAFT batch (maxPayout ${g(budget.maxPayout)})`,
    },
  ];
}

function fundSteps(state: SeedState, campaign: CampaignState): readonly PlanStep[] {
  const funded = campaign.onchain.sponsor !== zeroAddress;
  const status: StepStatus = funded ? 'done' : 'todo';
  const amount = g(campaign.budget.funding);
  const id = short(campaign.onchainId);
  const tail = `from operator ${state.operator} (needs SPONSOR_ROLE)`;
  if (state.permitAvailable) {
    return [
      {
        kind: 'sign',
        status,
        description: `G$ EIP-2612 permit(owner operator, spender VeriWorkCore, value ${amount}, deadline now + 1 h), domain GoodDollar / 1 / ${state.chainId}`,
      },
      tx(
        status,
        `VeriWorkCore.fundCampaignWithPermit(${id}, ${amount}, maxFeeBps ${DEMO_MAX_FEE_BPS}, deadline, v, r, s) ${tail}`,
        SEED_GAS.fundCampaignWithPermit,
      ),
    ];
  }
  return [
    tx(status, `G$.approve(VeriWorkCore, ${amount}) from operator`, SEED_GAS.approve),
    tx(
      status,
      `VeriWorkCore.fundCampaign(${id}, ${amount}, maxFeeBps ${DEMO_MAX_FEE_BPS}) ${tail}`,
      SEED_GAS.fundCampaign,
    ),
  ];
}

function publishSteps(
  state: SeedState,
  campaign: CampaignState,
  deadline: Date,
): readonly PlanStep[] {
  const batch = campaign.batches[0];
  const batchId = batch === undefined ? '<new batch id>' : short(batch.batch.onchainId);
  const onchain = batch?.onchainStatus ?? OnchainBatchStatus.None;
  const reservation = g(campaign.budget.funding);
  return [
    tx(
      onchain >= OnchainBatchStatus.AiDrafted ? 'done' : 'todo',
      `VeriWorkCore.openBatch(${batchId}, ${short(campaign.onchainId)}, maxPayout ${g(campaign.budget.maxPayout)}) from operator (OPERATOR_ROLE), reserves ${reservation}`,
      SEED_GAS.openBatch,
    ),
    {
      kind: 'sign',
      status: batch !== undefined && batch.undrafted === 0 ? 'done' : 'todo',
      description: `attach ${campaign.demo.items.length} curated AI drafts, each signed by the agent key ${state.agent ?? '(AI_AGENT_PRIVATE_KEY)'} over keccak256(canonicalJSON(output))`,
    },
    tx(
      onchain >= OnchainBatchStatus.InHumanReview ? 'done' : 'todo',
      `VeriWorkCore.markInHumanReview(${batchId}) from operator (OPERATOR_ROLE); review deadline ${deadline.toISOString()}`,
      SEED_GAS.markInHumanReview,
    ),
  ];
}

function problemsOf(state: SeedState, gDollarNeeded: bigint, celoMax: bigint): readonly string[] {
  const problems: string[] = [];
  if (!state.hasOperatorRole)
    problems.push(
      `operator ${state.operator} does not hold OPERATOR_ROLE (${short(OPERATOR_ROLE)}) on VeriWorkCore`,
    );
  if (!state.sponsorAdminIsOperator)
    problems.push(`OPERATOR_ROLE is not the admin of SPONSOR_ROLE (${short(SPONSOR_ROLE)})`);
  if (state.corePaused) problems.push('VeriWorkCore is paused');
  if (state.feeBps > DEMO_MAX_FEE_BPS)
    problems.push(`platform fee ${state.feeBps} bps is above maxFeeBps ${DEMO_MAX_FEE_BPS}`);
  if (state.gDollarBalance < gDollarNeeded)
    problems.push(`operator holds ${g(state.gDollarBalance)}, the seed needs ${g(gDollarNeeded)}`);
  if (state.celoBalance < celoMax)
    problems.push(
      `operator holds ${formatEther(state.celoBalance)} CELO, gas may need up to ${formatEther(celoMax)} CELO`,
    );
  return problems;
}

/** The exact plan for the current state: every database write, signature and transaction, in order. */
export function buildSeedPlan(state: SeedState, deadline: Date): SeedPlan {
  const steps: PlanStep[] = [
    ...state.campaigns.flatMap(dbSteps),
    tx(
      state.hasSponsorRole ? 'done' : 'todo',
      `VeriWorkCore.grantRole(SPONSOR_ROLE ${short(SPONSOR_ROLE)}, operator ${state.operator}) from operator (OPERATOR_ROLE is SPONSOR_ROLE's admin)`,
      SEED_GAS.grantRole,
    ),
    ...state.campaigns.flatMap((campaign) => [
      ...fundSteps(state, campaign),
      ...publishSteps(state, campaign, deadline),
    ]),
  ];
  const pendingTx = steps.filter((step) => step.kind === 'tx' && step.status === 'todo');
  const gas = pendingTx.reduce((sum, step) => sum + (step.gas ?? 0n), 0n);
  const baseFee = state.baseFeePerGas > 0n ? state.baseFeePerGas : CELO_BASE_FEE_FLOOR_WEI;
  const fees = workerFeeOverrides(baseFee);
  const gDollarNeeded = state.campaigns
    .filter((campaign) => campaign.onchain.sponsor === zeroAddress)
    .reduce((sum, campaign) => sum + campaign.budget.funding, 0n);
  const celoMax = gas * fees.maxFeePerGas;
  return {
    steps,
    problems: problemsOf(state, gDollarNeeded, celoMax),
    gDollarNeeded,
    transactions: pendingTx.length,
    gas,
    celoTypical: gas * (baseFee + DEFAULT_MAX_PRIORITY_FEE_PER_GAS_WEI),
    celoMax,
  };
}
