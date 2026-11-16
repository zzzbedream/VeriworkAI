'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReviewItemView } from '@veriwork/shared/api/work';
import { useCallback, useState } from 'react';
import type { Address } from 'viem';
import { apiErrorCode, type ClientErrorCode } from '@/lib/api/http';
import { useSession } from './useSession';
import { workQueueKey } from './useWorkQueues';

/** What happened to the last decision (shown above the next item). */
export type DecisionNotice = 'done' | 'conflict' | 'notEligible';
/** Why the last decision was not saved (shown next to the form). */
export type DecisionProblem = 'reason' | 'verify' | 'identity' | 'rateLimited' | 'network' | 'failed';

export type DecisionQueueState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly code: ClientErrorCode | null }
  | { readonly kind: 'empty' }
  | { readonly kind: 'item'; readonly submission: ReviewItemView };

export interface DecisionQueue<B> {
  readonly state: DecisionQueueState;
  readonly notice: DecisionNotice | null;
  readonly problem: DecisionProblem | null;
  readonly isSubmitting: boolean;
  submit(submissionId: string, body: B): void;
  refresh(): void;
}

export interface DecisionQueueOptions<B> {
  readonly queue: 'review' | 'qa';
  readonly fetchNext: (signal: AbortSignal) => Promise<{ readonly submission: ReviewItemView | null }>;
  readonly send: (submissionId: string, body: B) => Promise<unknown>;
}

function outcomeOf(code: ClientErrorCode | null): { notice: DecisionNotice } | { problem: DecisionProblem } {
  if (code === 'CONFLICT' || code === 'NOT_FOUND') return { notice: 'conflict' };
  if (code === 'NOT_ELIGIBLE') return { notice: 'notEligible' };
  if (code === 'VALIDATION_FAILED') return { problem: 'reason' };
  if (code === 'VERIFICATION_REQUIRED') return { problem: 'verify' };
  if (code === 'IDENTITY_UNAVAILABLE') return { problem: 'identity' };
  if (code === 'RATE_LIMITED') return { problem: 'rateLimited' };
  return { problem: code === 'NETWORK' ? 'network' : 'failed' };
}

interface Owned<T> {
  readonly owner: Address | null;
  readonly value: T;
}

/**
 * Review and QA queues: one item at a time; after a decision (or a refusal because someone else
 * decided first) the next item is loaded. A recorded QA vote never reveals anything about others.
 */
export function useDecisionQueue<B>({ queue, fetchNext, send }: DecisionQueueOptions<B>): DecisionQueue<B> {
  const session = useSession();
  const owner = session.address;
  const queryClient = useQueryClient();
  const queryKey = workQueueKey(queue, owner);
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => fetchNext(signal),
    enabled: session.status === 'signed-in',
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const [notice, setNotice] = useState<Owned<DecisionNotice> | null>(null);
  const [problem, setProblem] = useState<Owned<DecisionProblem> | null>(null);
  const mutation = useMutation({
    mutationFn: ({ submissionId, body }: { readonly submissionId: string; readonly body: B }) => send(submissionId, body),
  });

  const refresh = useCallback(() => {
    void queryClient.resetQueries({ queryKey: workQueueKey(queue, owner) });
  }, [owner, queue, queryClient]);

  const submit = useCallback(
    (submissionId: string, body: B) => {
      setProblem(null);
      mutation.mutate(
        { submissionId, body },
        {
          onSuccess: () => {
            setNotice({ owner, value: 'done' });
            refresh();
          },
          onError: (error) => {
            const outcome = outcomeOf(apiErrorCode(error));
            if ('notice' in outcome) {
              setNotice({ owner, value: outcome.notice });
              refresh();
            } else {
              setProblem({ owner, value: outcome.problem });
            }
          },
        },
      );
    },
    [mutation, owner, refresh],
  );

  const state: DecisionQueueState = query.isError
    ? { kind: 'error', code: apiErrorCode(query.error) }
    : query.data === undefined
      ? { kind: 'loading' }
      : query.data.submission === null
        ? { kind: 'empty' }
        : { kind: 'item', submission: query.data.submission };
  return {
    state,
    notice: notice !== null && notice.owner === owner ? notice.value : null,
    problem: problem !== null && problem.owner === owner ? problem.value : null,
    isSubmitting: mutation.isPending,
    submit,
    refresh: () => {
      setNotice(null);
      refresh();
    },
  };
}
