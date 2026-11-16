'use client';

import { useQuery } from '@tanstack/react-query';
import type { NextTaskResponse } from '@veriwork/shared/api/work';
import type { Address } from 'viem';
import { fetchNextTask } from '@/lib/api/work-client';
import { useSession } from './useSession';

export type WorkQueue = 'task' | 'review' | 'qa';

/** Queue queries are keyed by the signed-in address: another account never sees this one's items. */
export function workQueueKey(queue: WorkQueue, address: Address | null) {
  return ['work', queue, address] as const;
}

/** The next task of the signed-in worker. It stays put until the worker acts on it. */
export function useNextTask() {
  const session = useSession();
  return useQuery<NextTaskResponse>({
    queryKey: workQueueKey('task', session.address),
    queryFn: ({ signal }) => fetchNextTask(undefined, signal),
    enabled: session.status === 'signed-in',
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
}
