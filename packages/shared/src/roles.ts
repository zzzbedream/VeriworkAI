import { keccak256, stringToHex, type Hex } from 'viem';

/** OpenZeppelin AccessControl roles used by VeriWorkCore and AgentRegistry. */
export const DEFAULT_ADMIN_ROLE: Hex = `0x${'00'.repeat(32)}`;
/** Sentinel hot key: pause (and veto epochs) only. */
export const GUARDIAN_ROLE: Hex = keccak256(stringToHex('GUARDIAN_ROLE'));
/** Worker key: batches, settlement, slashing, agent suspension; admin of SPONSOR_ROLE. */
export const OPERATOR_ROLE: Hex = keccak256(stringToHex('OPERATOR_ROLE'));
/** B2B sponsors allowed to fund campaigns (granted by the operator). */
export const SPONSOR_ROLE: Hex = keccak256(stringToHex('SPONSOR_ROLE'));

export const CONTRACT_ROLES = {
  DEFAULT_ADMIN_ROLE,
  GUARDIAN_ROLE,
  OPERATOR_ROLE,
  SPONSOR_ROLE,
} as const;
export type ContractRoleName = keyof typeof CONTRACT_ROLES;

/** Name of a role hash, or `null` when unknown. */
export function contractRoleName(role: string): ContractRoleName | null {
  const normalized = role.toLowerCase();
  const entry = Object.entries(CONTRACT_ROLES).find(([, hash]) => hash === normalized);
  return entry === undefined ? null : (entry[0] as ContractRoleName);
}
