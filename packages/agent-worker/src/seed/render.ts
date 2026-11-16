import { formatGDollar } from '@veriwork/shared';
import { formatEther, formatGwei } from 'viem';
import type { SeedState } from './inspect';
import type { SeedPlan } from './plan';

const KIND: Readonly<Record<string, string>> = { db: 'DB ', tx: 'TX ', sign: 'SIG' };

/** Human-readable plan: preconditions, every step with its status, and the G$ / CELO totals. */
export function renderSeedPlan(
  plan: SeedPlan,
  state: SeedState,
  context: { readonly dryRun: boolean; readonly core: string },
): string {
  const header = `VeriWork demo seed ${context.dryRun ? 'plan (dry run: nothing is sent or written)' : 'run'}`;
  const facts = [
    `chain ${state.chainId}, VeriWorkCore ${context.core}`,
    `operator ${state.operator}: ${formatGDollar(state.gDollarBalance)}, ${formatEther(state.celoBalance)} CELO`,
    `roles: OPERATOR_ROLE ${state.hasOperatorRole ? 'yes' : 'NO'}, SPONSOR_ROLE ${state.hasSponsorRole ? 'yes' : 'no (granted by the plan)'}, OPERATOR_ROLE administers SPONSOR_ROLE ${state.sponsorAdminIsOperator ? 'yes' : 'NO'}`,
    `platform fee ${state.feeBps / 100}%; funding path: ${state.permitAvailable ? 'EIP-2612 permit + fundCampaignWithPermit' : 'approve + fundCampaign'}`,
    `core paused: ${state.corePaused ? 'YES' : 'no'}; base fee ${formatGwei(state.baseFeePerGas)} gwei`,
  ];
  const steps = plan.steps.map(
    (step, index) =>
      `  ${String(index + 1).padStart(2)}. [${step.status === 'done' ? 'done' : 'todo'}] ${KIND[step.kind] ?? step.kind} ${step.description}`,
  );
  const totals = [
    `G$ to escrow now: ${formatGDollar(plan.gDollarNeeded)} (worst-case payouts plus the platform fee)`,
    `transactions to send: ${plan.transactions}; gas <= ${plan.gas.toString()}`,
    `CELO for gas: about ${formatEther(plan.celoTypical)} at the current base fee, at most ${formatEther(plan.celoMax)} at maxFeePerGas`,
  ];
  const problems =
    plan.problems.length === 0
      ? ['  none']
      : plan.problems.map((problem) => `  BLOCKED: ${problem}`);
  return [
    header,
    ...facts.map((fact) => `  ${fact}`),
    'Steps:',
    ...steps,
    'Totals:',
    ...totals.map((line) => `  ${line}`),
    'Preconditions:',
    ...problems,
    '',
  ].join('\n');
}
