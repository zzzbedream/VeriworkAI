import 'server-only';
import { listBatches, listEpochs, type DbClient } from '@veriwork/database';
import { logServerError } from '../log';

/** What the judge guide can honestly mark as live, read from the pipeline state. */
export interface DemoLiveStatus {
  /** A published batch of a funded campaign is open: trial tasks, reviews and QA work end to end. */
  readonly openBatch: boolean;
  /** A week was settled on-chain: collecting earnings works end to end. */
  readonly settledWeek: boolean;
}

export const NOTHING_LIVE: DemoLiveStatus = { openBatch: false, settledWeek: false };

/** Never throws: when the database cannot be read, nothing that depends on it is shown as live. */
export async function getDemoLiveStatus(db: () => DbClient): Promise<DemoLiveStatus> {
  try {
    const client = db();
    const batches = await listBatches(client, { statuses: ['IN_HUMAN_REVIEW'], campaignStatuses: ['FUNDED', 'ACTIVE'], limit: 1 });
    const epochs = await listEpochs(client, { statuses: ['POSTED'], limit: 1 });
    return { openBatch: batches.length > 0, settledWeek: epochs.length > 0 };
  } catch (error: unknown) {
    logServerError('demo_status_unavailable', error);
    return NOTHING_LIVE;
  }
}
