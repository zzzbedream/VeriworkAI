import { z } from 'zod';
import { SubmissionStatus } from '../pipeline';
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

export const ReviewRequestSchema = z.strictObject({
  score: z.int().min(REVIEW_SCORE_MIN).max(REVIEW_SCORE_MAX),
  notes: z.string().trim().max(1_000).optional(),
});

export const ReviewResponseSchema = z.strictObject({
  submissionId: UuidSchema,
  status: SubmissionStatusSchema,
});

/** A submission shown to a QA voter, with the reviewer's assessment. */
export const QaItemViewSchema = ReviewItemViewSchema.extend({
  reviewerScore: z.int().min(REVIEW_SCORE_MIN).max(REVIEW_SCORE_MAX),
  reviewerNotes: z.string().nullable(),
  votesCast: z.int().min(0).max(2),
});

/** GET /api/qa/next */
export const NextQaResponseSchema = z.strictObject({
  submission: QaItemViewSchema.nullable(),
});

/** A rejection must say why (the reason feeds the dataset audit trail). */
export const QaVoteRequestSchema = z
  .strictObject({
    approve: z.boolean(),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .refine((vote) => vote.approve || vote.reason !== undefined, {
    error: 'A reason is required to reject',
    path: ['reason'],
  });

export const QaVoteResponseSchema = z.strictObject({
  submissionId: UuidSchema,
  votes: z.int().min(1).max(3),
  outcome: QaOutcomeSchema,
  status: SubmissionStatusSchema,
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
