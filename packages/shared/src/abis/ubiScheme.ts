import { parseAbi } from 'viem';

/**
 * UBISchemeV2 subset. Per-user records are keyed by the whitelisted ROOT. To know whether a root
 * claimed today use `lastClaimed(root) >= ubiDayStart(now)` — never `hasClaimed` (stale until the
 * first claim of the day) or `checkEntitlement(connected)` (does not resolve the root).
 */
export const ubiSchemeAbi = parseAbi([
  'function claim() returns (bool)',
  'function lastClaimed(address account) view returns (uint256)',
  'function periodStart() view returns (uint256)',
  'function currentDay() view returns (uint256)',
  'function dailyUbi() view returns (uint256)',
  'event UBIClaimed(address indexed claimer, uint256 amount)',
]);
