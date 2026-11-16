import { faucetRelayerJob } from '../gas/faucet-relayer';
import { indexerJob } from '../indexer/indexer';
import { epochWatchtowerJob } from '../monitor/epoch-watchtower';
import { outflowSentinelJob } from '../monitor/outflow-sentinel';
import { priceSentinelJob } from '../monitor/price-sentinel';
import { consensusJob } from '../pipeline/consensus';
import { orchestratorJob } from '../pipeline/orchestrator';
import { settlementJob } from '../pipeline/settlement';
import { stakesJob } from '../pipeline/stakes';
import { trialConversionJob } from '../pipeline/trial-conversion';
import { notificationsJob } from '../telegram/notifications';
import { walletWeekJob } from '../wallet-week/ubi-bits';
import type { Job } from './job';

/**
 * Every job, in `--once` order: chain state first (indexer), then safety (sentinel, watchtower),
 * gas help before anything that needs it, the pipeline, Wallet Week bits before the settlement that
 * reads them, slashing after the settlement, and notifications last.
 */
export const ALL_JOBS: readonly Job[] = [
  indexerJob,
  priceSentinelJob,
  outflowSentinelJob,
  epochWatchtowerJob,
  faucetRelayerJob,
  trialConversionJob,
  orchestratorJob,
  consensusJob,
  walletWeekJob,
  settlementJob,
  stakesJob,
  notificationsJob,
];
