import { parseAbi } from 'viem';

/**
 * GoodDollar IdentityV4 subset. Gate value actions on `getWhitelistedRoot(account) != 0` (never
 * `isWhitelisted`, which is false for connected wallets). `reverifyDaysOptions` is a `uint32[]`;
 * the real expiry is `identities(root).dateAuthenticated + reverifyDaysOptions(authCount) days`.
 */
export const identityAbi = parseAbi([
  'function getWhitelistedRoot(address account) view returns (address whitelisted)',
  'function isWhitelisted(address account) view returns (bool)',
  'function identities(address account) view returns (uint256 dateAuthenticated, uint256 dateAdded, string did, uint256 whitelistedOnChainId, uint8 status, uint32 authCount)',
  'function reverifyDaysOptions(uint256 index) view returns (uint32)',
  'function authenticationPeriod() view returns (uint256)',
  'function connectedAccounts(address account) view returns (address)',
  'event WhitelistedAdded(address indexed account)',
  'event WhitelistedAuthenticated(address indexed account, uint256 timestamp)',
  'event AccountConnected(address indexed connected, address indexed to)',
  'event AccountDisconnected(address indexed disconnected, address indexed from)',
]);
