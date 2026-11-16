import type { Hex } from 'viem';
import type { ChainSigner } from './clients';
import type { ContractWrite } from './tx-sender';

export type TxStepOutcome =
  | { readonly status: 'dry-run' }
  | { readonly status: 'confirmed'; readonly hash: Hex; readonly resumed: boolean };

export interface TxStep {
  readonly write: ContractWrite;
  /** Hash persisted by an earlier (possibly crashed) run, if any. */
  readonly persistedHash: Hex | null;
  /** Stores the hash after the broadcast, before waiting for the receipt. */
  readonly persist?: (hash: Hex) => Promise<void>;
}

/**
 * Sends a write unless an earlier run already did: a persisted hash that is mined is reused, one
 * still pending is waited for, and one that reverted or vanished is sent again. Callers read the
 * contract state first and only call this when the state still needs the write.
 */
export async function sendOrResume(signer: ChainSigner, step: TxStep): Promise<TxStepOutcome> {
  const { sender } = signer;
  const persisted = step.persistedHash;
  if (persisted !== null) {
    const state = await sender.check(persisted);
    if (state === 'success') return { status: 'confirmed', hash: persisted, resumed: true };
    if (state === 'pending') {
      await sender.waitFor(step.write.label, persisted);
      return { status: 'confirmed', hash: persisted, resumed: true };
    }
  }
  const outcome = await sender.send(
    step.write,
    step.persist === undefined ? {} : { onSent: step.persist },
  );
  return outcome.status === 'dry-run'
    ? { status: 'dry-run' }
    : { status: 'confirmed', hash: outcome.hash, resumed: false };
}
