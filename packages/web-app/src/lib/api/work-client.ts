import { routePath } from '@veriwork/shared/api/routes';
import {
  NextQaResponseSchema,
  NextReviewResponseSchema,
  NextTaskResponseSchema,
  QaVoteResponseSchema,
  ReviewResponseSchema,
  SubmitTaskResponseSchema,
  type NextQaResponse,
  type NextReviewResponse,
  type NextTaskResponse,
  type QaVoteRequest,
  type QaVoteResponse,
  type ReviewRequest,
  type ReviewResponse,
  type SubmitTaskResponse,
} from '@veriwork/shared/api/work';
import { getJson, postJson } from './http';

/** GET /api/tasks/next (optionally for one language). */
export function fetchNextTask(language?: string, signal?: AbortSignal): Promise<NextTaskResponse> {
  const query = language === undefined ? '' : `?${new URLSearchParams({ language }).toString()}`;
  return getJson(`/api/tasks/next${query}`, NextTaskResponseSchema, signal);
}

/** POST /api/tasks/{itemId}/submit */
export function submitTask(itemId: string, correction: unknown): Promise<SubmitTaskResponse> {
  return postJson(routePath('/api/tasks/{itemId}/submit', { itemId }), { correction }, SubmitTaskResponseSchema);
}

/** GET /api/review/next */
export function fetchNextReview(signal?: AbortSignal): Promise<NextReviewResponse> {
  return getJson('/api/review/next', NextReviewResponseSchema, signal);
}

/** POST /api/review/{submissionId} */
export function submitReview(submissionId: string, review: ReviewRequest): Promise<ReviewResponse> {
  return postJson(routePath('/api/review/{submissionId}', { submissionId }), review, ReviewResponseSchema);
}

/** GET /api/qa/next */
export function fetchNextQa(signal?: AbortSignal): Promise<NextQaResponse> {
  return getJson('/api/qa/next', NextQaResponseSchema, signal);
}

/** POST /api/qa/{submissionId} */
export function submitQaVote(submissionId: string, vote: QaVoteRequest): Promise<QaVoteResponse> {
  return postJson(routePath('/api/qa/{submissionId}', { submissionId }), vote, QaVoteResponseSchema);
}
