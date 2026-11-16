import { keccak256, stringToHex, type Address, type Hex } from 'viem';
import { CELO_CHAIN_ID } from './chain';

/**
 * EIP-712 consent the AI agent key signs before its owner registers it in AgentRegistry:
 * `registerAgent(agent, metadataHash, maxBond, consentDeadline, consentSignature)` (or the permit
 * variant) reverts `ConsentExpired(deadline)` after the deadline and `InvalidConsent(agent)` for any
 * other mismatch. The registry accepts an ECDSA signature by the agent key (also for an EIP-7702
 * delegated agent address), else ERC-1271 when the agent address is a contract; use a plain EOA agent
 * key. `owner` is the wallet that sends the registration. The digest equals the contract's
 * `consentDigest(owner, metadataHash, deadline)` (pinned by a test vector read from the contract).
 */
export const AGENT_REGISTRY_DOMAIN = { name: 'VeriWork AgentRegistry', version: '1' } as const;

/** Encoded `AgentConsent` type and its typehash, for cross-checks against the contract. */
export const AGENT_CONSENT_TYPE =
  'AgentConsent(address owner,bytes32 metadataHash,uint256 deadline)';
export const AGENT_CONSENT_TYPEHASH: Hex = keccak256(stringToHex(AGENT_CONSENT_TYPE));

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
