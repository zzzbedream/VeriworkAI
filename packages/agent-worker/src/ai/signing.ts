import { hashCanonicalJson, type TaskOutput } from '@veriwork/shared';
import { verifyMessage, type Address, type Hex } from 'viem';
import type { KeySigner } from '../chain/clients';

export interface SignedDraft {
  /** `keccak256(canonicalJSON(output))`, the value `recordAiDraft` re-checks. */
  readonly outputHash: Hex;
  readonly signature: Hex;
  readonly agentAddress: Address;
}

/**
 * The AI agent key signs `keccak256(canonicalJSON(output))` of every draft. The 32-byte hash is
 * signed as an EIP-191 personal message (`signMessage({ message: { raw: hash } })`), so the agent
 * key can never be tricked into signing a transaction; check it with `verifyDraftSignature`.
 */
export async function signDraft(agent: KeySigner, output: TaskOutput): Promise<SignedDraft> {
  const outputHash = hashCanonicalJson(output);
  const signature = await agent.wallet.signMessage({
    account: agent.account,
    message: { raw: outputHash },
  });
  return { outputHash, signature, agentAddress: agent.account.address };
}

export async function verifyDraftSignature(draft: SignedDraft): Promise<boolean> {
  return verifyMessage({
    address: draft.agentAddress,
    message: { raw: draft.outputHash },
    signature: draft.signature,
  });
}
