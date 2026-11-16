import type { QaCandidate, ReviewCandidate, TaskCandidate, TrialSessionRecord } from '@veriwork/database';
import { trialSummary, type TrialSummary } from '@veriwork/shared/api/me';
import type { QaItemView, ReviewItemView, TaskItemView } from '@veriwork/shared/api/work';

type JsonView = TaskItemView['input'];

/** Values read from `Json` columns are JSON already; this only narrows Prisma's type to the API's. */
function json(value: unknown): JsonView {
  return value as JsonView;
}

/** Trial counters for the API (an untouched trial when the wallet never did one). */
export function trialSummaryOf(session: TrialSessionRecord | null): TrialSummary {
  return trialSummary(
    session === null
      ? null
      : {
          tasksCompleted: session.tasksCompleted,
          escrowedWei: session.escrowedWei,
          converted: session.convertedToVerifiedAt !== null,
        },
  );
}

/** An item for a worker: instructions, input and the AI contributor's draft (all rendered as text). */
export function toTaskItemView(task: TaskCandidate, isTrial: boolean): TaskItemView {
  return {
    itemId: task.itemId,
    batchId: task.batchId,
    campaignId: task.campaignId,
    taskType: task.taskType,
    title: task.title,
    instructions: task.instructions,
    input: json(task.input),
    aiDraft: task.aiDraft === null ? null : json(task.aiDraft),
    aiModel: task.aiModel,
    rewardWei: task.rewardWei.toString(),
    isTrial,
  };
}

/** A submission for a reviewer: the work only, never who did it. */
export function toReviewItemView(candidate: ReviewCandidate): ReviewItemView {
  return {
    submissionId: candidate.submission.id,
    itemId: candidate.submission.itemId,
    taskType: candidate.taskType,
    instructions: candidate.instructions,
    input: json(candidate.input),
    aiDraft: candidate.aiDraft === null ? null : json(candidate.aiDraft),
    correction: json(candidate.submission.humanCorrection),
    submittedAt: candidate.submission.createdAt.toISOString(),
  };
}

/** A submission for a QA voter: blind (no reviewer verdict, no other votes, no worker identity). */
export function toQaItemView(candidate: QaCandidate): QaItemView {
  return {
    submissionId: candidate.submissionId,
    itemId: candidate.itemId,
    taskType: candidate.taskType,
    instructions: candidate.instructions,
    input: json(candidate.input),
    aiDraft: candidate.aiDraft === null ? null : json(candidate.aiDraft),
    correction: json(candidate.correction),
    submittedAt: candidate.submittedAt.toISOString(),
  };
}
