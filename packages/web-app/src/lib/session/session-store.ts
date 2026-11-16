import type { Address } from 'viem';
import { create } from 'zustand';

/** Polling window after the user comes back from GoodDollar's face verification. */
export interface VerificationPoll {
  readonly address: Address;
  readonly until: number;
}

interface SessionUiState {
  readonly verificationPoll: VerificationPoll | null;
  /** Account whose polling window ended without the verification showing up yet. */
  readonly verificationPollTimedOut: Address | null;
  startVerificationPoll(address: Address, durationMs: number): void;
  stopVerificationPoll(): void;
  /** Drops everything that belongs to another account (called on every account change). */
  resetForAddress(address: Address | null): void;
}

let pollTimer: ReturnType<typeof setTimeout> | undefined;

function clearTimer(): void {
  if (pollTimer !== undefined) clearTimeout(pollTimer);
  pollTimer = undefined;
}

/** Ephemeral, per-tab UI state of the wallet session (never persisted). */
export const useSessionStore = create<SessionUiState>()((set, get) => ({
  verificationPoll: null,
  verificationPollTimedOut: null,
  startVerificationPoll(address, durationMs) {
    clearTimer();
    const until = Date.now() + durationMs;
    set({ verificationPoll: { address, until }, verificationPollTimedOut: null });
    pollTimer = setTimeout(() => {
      if (get().verificationPoll?.until === until) set({ verificationPoll: null, verificationPollTimedOut: address });
    }, durationMs);
  },
  stopVerificationPoll() {
    clearTimer();
    set({ verificationPoll: null, verificationPollTimedOut: null });
  },
  resetForAddress(address) {
    const state = get();
    const pollIsOurs = state.verificationPoll === null || state.verificationPoll.address === address;
    const timeoutIsOurs = state.verificationPollTimedOut === null || state.verificationPollTimedOut === address;
    if (pollIsOurs && timeoutIsOurs) return;
    clearTimer();
    set({ verificationPoll: null, verificationPollTimedOut: null });
  },
}));
