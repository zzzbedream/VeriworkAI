import { useSyncExternalStore } from 'react';

/** The UI only needs coarse time (UBI-day boundaries, expiry dates): tick every 15 seconds. */
export const CLOCK_TICK_MS = 15_000;

const listeners = new Set<() => void>();
let current = Math.floor(Date.now() / 1_000);
let timer: ReturnType<typeof setInterval> | undefined;

function tick(): void {
  const next = Math.floor(Date.now() / 1_000);
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  tick();
  timer ??= setInterval(tick, CLOCK_TICK_MS);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

function getSnapshot(): number {
  return current;
}

/** Current unix time in seconds, re-rendering subscribers every tick (render-safe "now"). */
export function useNowSeconds(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
