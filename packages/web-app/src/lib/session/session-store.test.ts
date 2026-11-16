import type { Address } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionStore } from './session-store';

const A = '0x1111111111111111111111111111111111111111' as Address;
const B = '0x2222222222222222222222222222222222222222' as Address;

describe('session UI store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useSessionStore.getState().stopVerificationPoll();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps a verification poll for its duration only', () => {
    useSessionStore.getState().startVerificationPoll(A, 180_000);
    expect(useSessionStore.getState().verificationPoll?.address).toBe(A);
    vi.advanceTimersByTime(179_999);
    expect(useSessionStore.getState().verificationPoll).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(useSessionStore.getState().verificationPoll).toBeNull();
  });

  it('drops state of other accounts on an account change, keeps the current one', () => {
    useSessionStore.getState().startVerificationPoll(A, 180_000);
    useSessionStore.getState().resetForAddress(A);
    expect(useSessionStore.getState().verificationPoll?.address).toBe(A);
    useSessionStore.getState().resetForAddress(B);
    expect(useSessionStore.getState().verificationPoll).toBeNull();
    useSessionStore.getState().startVerificationPoll(A, 1_000);
    useSessionStore.getState().resetForAddress(null);
    expect(useSessionStore.getState().verificationPoll).toBeNull();
  });

  it('replaces an older poll and ignores its timer', () => {
    useSessionStore.getState().startVerificationPoll(A, 1_000);
    useSessionStore.getState().startVerificationPoll(A, 5_000);
    vi.advanceTimersByTime(1_000);
    expect(useSessionStore.getState().verificationPoll).not.toBeNull();
    useSessionStore.getState().stopVerificationPoll();
    expect(useSessionStore.getState().verificationPoll).toBeNull();
  });
});
