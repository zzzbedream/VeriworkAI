import { parseAbi } from 'viem';

/**
 * GoodDollar gas Faucet subset. Anyone may call `topWallet(user)` for a whitelisted (or connected)
 * user and gets its gas refunded; tops only happen below 0.21 CELO, at most 3 per day per root.
 * `canTop` ignores authorization, so a non-whitelisted target can still revert "not authorized".
 */
export const faucetAbi = parseAbi([
  'function canTop(address user) view returns (bool)',
  'function topWallet(address user)',
  'function getToppingAmount() view returns (uint256)',
  'function minTopping() view returns (uint8)',
  'event WalletTopped(address indexed account, uint256 amount, address whitelistedRoot, address indexed relayerOrWhitelisted)',
]);
