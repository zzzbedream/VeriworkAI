import type { Address, Hex } from 'viem';
import { CELO_CHAIN_ID } from './chain';

/**
 * EIP-712 consent the AI agent key signs before its owner registers it in AgentRegistry
 * (`registerAgent` checks it with SignatureChecker, so ERC-1271 agents work too). Keep in sync with the
 * contract and re-check after regenerating the ABIs.
 */
export const AGENT_REGISTRY_DOMAIN = { name: 'VeriWork AgentRegistry', version: '1' } as const;

export const AGENT_CONSENT_TYPES = {
  AgentConsent: [
    { name: 'owner', type: 'address' },
    { name: 'metadataHash', type: 'bytes32' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

export interface AgentConsentMessage {
  /** Human (verified root's wallet) that will call `registerAgent`. */
  readonly owner: Address;
  /** keccak256 of the agent metadata (name, model, operator contact). */
  readonly metadataHash: Hex;
  /** Unix seconds after which the consent is void. */
  readonly deadline: bigint;
}

/** Typed data for viem `signTypedData` (signed by the agent key). */
export function agentConsentTypedData(
  message: AgentConsentMessage,
  verifyingContract: Address,
  chainId: number = CELO_CHAIN_ID,
) {
  return {
    domain: { ...AGENT_REGISTRY_DOMAIN, chainId, verifyingContract },
    types: AGENT_CONSENT_TYPES,
    primaryType: 'AgentConsent',
    message: {
      owner: message.owner,
      metadataHash: message.metadataHash,
      deadline: message.deadline,
    },
  } as const;
}
