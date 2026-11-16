import {
  SECONDS_PER_HOUR,
  SECONDS_PER_WEEK,
  SLASH_WINDOW_START,
  weekId,
  weekStart,
} from '@veriwork/shared';

/**
 * Review deadline of a newly published batch: the QA close (Saturday 12:00 UTC) `reviewWeeks - 1`
 * weeks after this week's, pushed one more week when it is less than `minReviewHours` away.
 */
export function reviewDeadline(
  nowSeconds: number,
  reviewWeeks: number,
  minReviewHours: number,
): Date {
  const thisWeeksClose = weekStart(weekId(nowSeconds)) + SLASH_WINDOW_START;
  const target = thisWeeksClose + (reviewWeeks - 1) * SECONDS_PER_WEEK;
  const close =
    target - nowSeconds < minReviewHours * SECONDS_PER_HOUR ? target + SECONDS_PER_WEEK : target;
  return new Date(close * 1_000);
}
