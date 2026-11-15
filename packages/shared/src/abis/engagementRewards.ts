import { parseAbi, type Address } from 'viem';
import { ENGAGEMENT_REWARDS_DOMAIN } from '../addresses';
import { CELO_CHAIN_ID } from '../chain';

/**
 * GoodDollar EngagementRewards subset. For a non-contract app the USER sends
 * `nonContractAppClaim(app, inviter, validUntilBlock, userSignature, appSignature)`; the app
 * signature is EIP-712 `AppClaim(app, user = msg.sender, validUntilBlock)` with
 * `block <= validUntilBlock <= block + 600`.
 */
export const engagementRewardsAbi = parseAbi([
  'function nonContractAppClaim(address app, address inviter, uint256 validUntilBlock, bytes userSignature, bytes appSignature) returns (bool)',
  'function appClaim(address user, address inviter, uint256 validUntilBlock, bytes signature) returns (bool)',
  'function appClaim(address user, address inviter, uint256 validUntilBlock, bytes signature, uint8 userAndInviterPercentage, uint8 userPercentage) returns (bool)',
  'function registeredApps(address app) view returns (address owner, address rewardReceiver, uint96 totalRewardsClaimed, uint32 registeredAt, uint32 lastResetAt, uint8 userAndInviterPercentage, uint8 userPercentage, bool isRegistered, bool isApproved, string description, string url, string email, address app, address signer)',
  'function userRegistrations(address app, address user) view returns (uint32 isRegistered, uint32 lastClaimTimestamp)',
  'function canClaim(address app, address user) view returns (bool)',
  'function rewardAmount() view returns (uint96)',
  'event RewardClaimed(address indexed app, address indexed user, address indexed inviter, uint256 appReward, uint256 userAmount, uint256 inviterAmount)',
]);

/** EIP-712 types signed by the app (or its signer/owner) for `nonContractAppClaim`. */
export const ENGAGEMENT_APP_CLAIM_TYPES = {
  AppClaim: [
    { name: 'app', type: 'address' },
    { name: 'user', type: 'address' },
    { name: 'validUntilBlock', type: 'uint256' },
  ],
} as const;

/** EIP-712 types signed by the user (first claim or after the app re-applies). */
export const ENGAGEMENT_USER_CLAIM_TYPES = {
  Claim: [
    { name: 'app', type: 'address' },
    { name: 'inviter', type: 'address' },
    { name: 'validUntilBlock', type: 'uint256' },
    { name: 'description', type: 'string' },
  ],
} as const;

export interface AppClaimMessage {
  readonly app: Address;
  readonly user: Address;
  readonly validUntilBlock: bigint;
}

/**
 * EIP-712 typed data the app signer signs for `nonContractAppClaim` (`user` = the wallet that will
 * send the claim). Pass the result to viem `signTypedData`.
 */
export function engagementAppClaimTypedData(
  message: AppClaimMessage,
  verifyingContract: Address,
  chainId: number = CELO_CHAIN_ID,
) {
  return {
    domain: { ...ENGAGEMENT_REWARDS_DOMAIN, chainId, verifyingContract },
    types: ENGAGEMENT_APP_CLAIM_TYPES,
    primaryType: 'AppClaim',
    message: { app: message.app, user: message.user, validUntilBlock: message.validUntilBlock },
  } as const;
}
