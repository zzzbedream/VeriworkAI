import 'server-only';
import type { DbClient } from '@veriwork/database';
import { parseTaskInput, parseTaskOutput, type TaskOutput, type TaskType } from '@veriwork/shared/task-content';
import type { Address } from 'viem';
import type { CoreReader } from '../chain/core-reader';
import { ApiFailure } from '../http/errors';
import { logServerError } from '../log';

export interface TaskContent {
  readonly taskType: TaskType;
  readonly input: unknown;
  /** Upskill module the campaign requires (`hasModule(root, id)`), `null` for none. */
  readonly requiredModuleId: number | null;
}

const ITEM_UNAVAILABLE = 'This task is no longer available. Here is another one.';

/**
 * Task type, input and module requirement of an item, read-only. `@veriwork/database` has no item
 * lookup by id yet; this single select stays here until it does (the repository re-checks the item
 * when the submission is created).
 */
export async function loadTaskContent(db: DbClient, itemId: string): Promise<TaskContent> {
  const item = await db.taskItem.findUnique({
    where: { id: itemId },
    select: { input: true, batch: { select: { campaign: { select: { taskType: true, requiredModuleId: true } } } } },
  });
  if (item === null) throw new ApiFailure('NOT_FOUND', 'This task does not exist.');
  const { taskType, requiredModuleId } = item.batch.campaign;
  return { taskType, input: item.input, requiredModuleId };
}

/**
 * Module-gated campaigns pay only humans whose root owns the module, read on-chain for this action
 * (`createSubmission` does not check modules). Trial wallets have no root, so they never qualify.
 */
export async function assertModuleAccess(chain: CoreReader, content: TaskContent, root: Address | null): Promise<void> {
  if (content.requiredModuleId === null) return;
  if (root === null) throw new ApiFailure('ITEM_UNAVAILABLE', ITEM_UNAVAILABLE);
  let owns: boolean;
  try {
    owns = await chain.ownsModule(root, content.requiredModuleId);
  } catch (error: unknown) {
    logServerError('module_check_unavailable', error);
    throw new ApiFailure('IDENTITY_UNAVAILABLE', "We couldn't check this task's requirements on Celo right now. Please try again.");
  }
  if (!owns) throw new ApiFailure('ITEM_UNAVAILABLE', ITEM_UNAVAILABLE);
}

/**
 * Checks a worker's correction against the item's task type and input (`parseTaskOutput`: e.g. a
 * ranking must be a permutation of the responses, labels must come from the item) and returns the
 * normalized output to store. The answer never echoes item details.
 */
export function checkCorrection(content: TaskContent, correction: unknown): TaskOutput {
  const input = parseTaskInput(content.taskType, content.input);
  if (!input.ok) throw new ApiFailure('ITEM_UNAVAILABLE', ITEM_UNAVAILABLE);
  const output = parseTaskOutput(content.taskType, input.value, correction);
  if (!output.ok) throw new ApiFailure('INVALID_OUTPUT', 'Your correction is incomplete or does not fit this task.');
  return output.value;
}
