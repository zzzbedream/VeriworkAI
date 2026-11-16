import { z } from 'zod';
import { isReviewReasonRequired, SubmissionStatus, SubmissionVoidReason } from '../pipeline';
import {
  boundedJson,
  IsoDateTimeSchema,
  LanguageCodeSchema,
  UuidSchema,
  WeiStringSchema,
} from '../schemas';
import { TaskTypeSchema } from '../task-content';
import { REVIEW_SCORE_MAX, REVIEW_SCORE_MIN } from '../tokenomics';
import { TrialSummarySchema } from './me';

/** Task inputs, AI drafts and corrections are bounded JSON (rendered as text, never as HTML). */
export const TASK_JSON_MAX_BYTES = 32_000;
const TaskJsonSchema = boundedJson(TASK_JSON_MAX_BYTES);

export const SubmissionStatusSchema = z.enum(SubmissionStatus);
export const SubmissionVoidReasonSchema = z.enum(SubmissionVoidReason);
export const QaOutcomeSchema = z.enum(['PENDING', 'ACCEPTED', 'REJECTED']);

/** An item served to a worker: instructions, input and the AI contributor's draft to correct. */
export const TaskItemViewSchema = z.strictObject({
  itemId: UuidSchema,
  batchId: UuidSchema,
  campaignId: UuidSchema,
  taskType: TaskTypeSchema,
  title: z.string(),
  instructions: z.string(),
  input: TaskJsonSchema,
  aiDraft: TaskJsonSchema.nullable(),
  aiModel: z.string().nullable(),
  rewardWei: WeiStringSchema,
  isTrial: z.boolean(),
});

/** GET /api/tasks/next */
export const NextTaskQuerySchema = z.strictObject({
  language: LanguageCodeSchema.optional(),
});

export const NextTaskResponseSchema = z.strictObject({
  task: TaskItemViewSchema.nullable(),
  /** Present for unverified callers (trial path). */
  trial: TrialSummarySchema.nullable(),
});

/** POST /api/tasks/{itemId}/submit */
export const TaskItemParamsSchema = z.strictObject({ itemId: UuidSchema });

export const SubmitTaskRequestSchema = z.strictObject({
  /** Validated against the task type with `parseTaskOutput` on the server. */
  correction: TaskJsonSchema,
});

export const SubmitTaskResponseSchema = z.strictObject({
  submissionId: UuidSchema,
  status: SubmissionStatusSchema,
  isTrial: z.boolean(),
  trial: TrialSummarySchema.nullable(),
});

/** A submission shown to a reviewer (worker identity is never exposed). */
export const ReviewItemViewSchema = z.strictObject({
  submissionId: UuidSchema,
  itemId: UuidSchema,
  taskType: TaskTypeSchema,
  instructions: z.string(),
  input: TaskJsonSchema,
  aiDraft: TaskJsonSchema.nullable(),
  correction: TaskJsonSchema,
  submittedAt: IsoDateTimeSchema,
});

/** GET /api/review/next */
export const NextReviewResponseSchema = z.strictObject({
  submission: ReviewItemViewSchema.nullable(),
});

/** POST /api/review/{submissionId} and POST /api/qa/{submissionId} */
export const SubmissionParamsSchema = z.strictObject({ submissionId: UuidSchema });

/**
 * Optional free text, trimmed; blank text (a form's empty textarea) counts as absent, so it never
 * fails validation on its own and never satisfies a required reason.
 */
function optionalText(maxLength: number) {
  return z
    .string()
    .trim()
    .max(maxLength)
    .transform((text) => (text === '' ? undefined : text))
    .optional();
}

/**
 * Score 1-5 (3 or more = accept). A score below 3 must say why. Whatever the score the submission
 * goes to QA, and the reviewer is paid when the verdict matches the QA consensus.
 */
export const ReviewRequestSchema = z
  .strictObject({
    score: z.int().min(REVIEW_SCORE_MIN).max(REVIEW_SCORE_MAX),
    notes: optionalText(1_000),
  })
  .refine((review) => !isReviewReasonRequired(review.score) || review.notes !== undefined, {
    error: 'A reason is required for a score below 3',
    path: ['notes'],
  });

export const ReviewResponseSchema = z.strictObject({
  submissionId: UuidSchema,
  status: SubmissionStatusSchema,
});

/**
 * A submission shown to a QA voter. Voting is blind: no reviewer score, notes or verdict, no other
 * votes or vote count, and no worker identity (the strict schema refuses every extra field).
 */
export const QaItemViewSchema = ReviewItemViewSchema;

/** GET /api/qa/next */
export const NextQaResponseSchema = z.strictObject({
  submission: QaItemViewSchema.nullable(),
});

/** A rejection must say why (the reason feeds the dataset audit trail). */
export const QaVoteRequestSchema = z
  .strictObject({
    approve: z.boolean(),
    reason: optionalText(500),
  })
  .refine((vote) => vote.approve || vote.reason !== undefined, {
    error: 'A reason is required to reject',
    path: ['reason'],
  });

/**
 * The vote was recorded. Nothing else: the vote count, the outcome or the submission's status would
 * tell the voter how the others voted (voting stays blind after the vote too).
 */
export const QaVoteResponseSchema = z.strictObject({
  submissionId: UuidSchema,
  recorded: z.literal(true),
});

export type TaskItemView = z.infer<typeof TaskItemViewSchema>;
export type NextTaskQuery = z.infer<typeof NextTaskQuerySchema>;
export type NextTaskResponse = z.infer<typeof NextTaskResponseSchema>;
export type SubmitTaskRequest = z.infer<typeof SubmitTaskRequestSchema>;
export type SubmitTaskResponse = z.infer<typeof SubmitTaskResponseSchema>;
export type ReviewItemView = z.infer<typeof ReviewItemViewSchema>;
export type NextReviewResponse = z.infer<typeof NextReviewResponseSchema>;
export type ReviewRequest = z.infer<typeof ReviewRequestSchema>;
export type ReviewResponse = z.infer<typeof ReviewResponseSchema>;
export type QaItemView = z.infer<typeof QaItemViewSchema>;
export type NextQaResponse = z.infer<typeof NextQaResponseSchema>;
export type QaVoteRequest = z.infer<typeof QaVoteRequestSchema>;
export type QaVoteResponse = z.infer<typeof QaVoteResponseSchema>;
