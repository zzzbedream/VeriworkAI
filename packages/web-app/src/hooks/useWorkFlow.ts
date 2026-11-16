'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { TrialSummary } from '@veriwork/shared/api/me';
import type { SubmitTaskResponse, TaskItemView } from '@veriwork/shared/api/work';
import { useCallback, useState } from 'react';
import type { Address } from 'viem';
import { apiErrorCode, type ClientErrorCode } from '@/lib/api/http';
import { submitTask } from '@/lib/api/work-client';
import type { AnyTaskOutput } from '@/lib/work/content';
import { useGoodIDBoundary } from './useGoodIDBoundary';
import { SESSION_QUERY_KEY, useSession } from './useSession';
import { useNextTask, workQueueKey } from './useWorkQueues';

export type WorkView =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly code: ClientErrorCode | null }
  /** The trial is used up: verification comes next (the 3rd action opens the modal). */
  | { readonly kind: 'trialDone' }
  | { readonly kind: 'saved'; readonly result: SubmitTaskResponse }
  | { readonly kind: 'empty'; readonly trial: TrialSummary | null }
  | { readonly kind: 'task'; readonly task: TaskItemView; readonly trial: TrialSummary | null };

/** Why the last submission was not saved (shown next to the form). */
export type SubmitProblem = 'incomplete' | 'identity' | 'rateLimited' | 'network' | 'failed';

export interface WorkFlow {
  readonly view: WorkView;
  /** The previous task was taken by someone else; a new one is shown. */
  readonly taken: boolean;
  readonly problem: SubmitProblem | null;
  readonly isSubmitting: boolean;
  readonly verifyOpen: boolean;
  submit(itemId: string, correction: AnyTaskOutput): void;
  /** "Next task" / "Check again" / "Keep working". */
  next(): void;
  closeVerify(): void;
}

const TAKEN_CODES: readonly (ClientErrorCode | null)[] = ['ALREADY_SUBMITTED', 'ITEM_UNAVAILABLE', 'NOT_FOUND', 'CONFLICT'];
const VERIFY_CODES: readonly (ClientErrorCode | null)[] = ['TRIAL_LIMIT_REACHED', 'VERIFICATION_REQUIRED'];

function problemOf(code: ClientErrorCode | null): SubmitProblem {
  if (code === 'INVALID_OUTPUT' || code === 'VALIDATION_FAILED') return 'incomplete';
  if (code === 'IDENTITY_UNAVAILABLE') return 'identity';
  if (code === 'RATE_LIMITED') return 'rateLimited';
  return code === 'NETWORK' ? 'network' : 'failed';
}

interface Owned<T> {
  readonly owner: Address | null;
  readonly value: T;
}

/**
 * The task loop of /work. Trial work is limited by the server (2 tasks, counted atomically); once
 * the server says the trial is used up, the next action opens the GoodID modal instead.
 */
export function useWorkFlow(): WorkFlow {
  const session = useSession();
  const boundary = useGoodIDBoundary();
  const owner = session.address;
  const queryClient = useQueryClient();
  const next = useNextTask();
  const [saved, setSaved] = useState<Owned<SubmitTaskResponse> | null>(null);
  const [taken, setTaken] = useState<Owned<boolean> | null>(null);
  const [problem, setProblem] = useState<Owned<SubmitProblem> | null>(null);
  // Keyed by account: an account switch never carries the modal over to another wallet.
  const [verifyFor, setVerifyFor] = useState<Address | null>(null);
  const mutation = useMutation({
    mutationFn: ({ itemId, correction }: { readonly itemId: string; readonly correction: AnyTaskOutput }) =>
      submitTask(itemId, correction),
  });

  const mine = <T,>(state: Owned<T> | null): T | null => (state !== null && state.owner === owner ? state.value : null);
  const savedResult = mine(saved);
  const nextCode = next.isError ? apiErrorCode(next.error) : null;
  const trialDone = nextCode === 'VERIFICATION_REQUIRED' || (savedResult?.isTrial === true && savedResult.trial?.remaining === 0);
  // Verified meanwhile (e.g. in another tab): ask the server again instead of opening the modal.
  const mustVerify = trialDone && boundary.status !== 'verified';

  const refetchNext = useCallback(() => {
    void queryClient.resetQueries({ queryKey: workQueueKey('task', owner) });
  }, [owner, queryClient]);

  const goNext = useCallback(() => {
    if (mustVerify) {
      setVerifyFor(owner);
      return;
    }
    setSaved(null);
    setTaken(null);
    setProblem(null);
    refetchNext();
  }, [mustVerify, owner, refetchNext]);

  const submit = useCallback(
    (itemId: string, correction: AnyTaskOutput) => {
      if (mustVerify) {
        setVerifyFor(owner);
        return;
      }
      setProblem(null);
      mutation.mutate(
        { itemId, correction },
        {
          onSuccess: (result) => {
            setSaved({ owner, value: result });
            setTaken(null);
            void queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
          },
          onError: (error) => {
            const code = apiErrorCode(error);
            if (VERIFY_CODES.includes(code)) {
              setVerifyFor(owner);
              refetchNext();
            } else if (TAKEN_CODES.includes(code)) {
              setTaken({ owner, value: true });
              refetchNext();
            } else {
              setProblem({ owner, value: problemOf(code) });
            }
          },
        },
      );
    },
    [mustVerify, mutation, owner, queryClient, refetchNext],
  );

  return {
    view: deriveView(next, savedResult, nextCode),
    taken: mine(taken) === true,
    problem: mine(problem),
    isSubmitting: mutation.isPending,
    verifyOpen: verifyFor !== null && verifyFor === owner,
    submit,
    next: goNext,
    closeVerify: () => setVerifyFor(null),
  };
}

function deriveView(
  next: ReturnType<typeof useNextTask>,
  saved: SubmitTaskResponse | null,
  nextCode: ClientErrorCode | null,
): WorkView {
  if (saved !== null) return { kind: 'saved', result: saved };
  if (nextCode === 'VERIFICATION_REQUIRED') return { kind: 'trialDone' };
  if (next.isError) return { kind: 'error', code: nextCode };
  if (next.data === undefined) return { kind: 'loading' };
  const { task, trial } = next.data;
  return task === null ? { kind: 'empty', trial } : { kind: 'task', task, trial };
}
