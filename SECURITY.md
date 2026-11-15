# Security

## Reporting a vulnerability

Please **do not open a public issue**. Report privately through GitHub's "Report a vulnerability" (Security
Advisories) on this repository. Include the affected contract or route, impact, and a reproduction. We aim to
acknowledge within 48 hours. Funds at risk are paused first, then investigated.

## Status

The contracts are unaudited. They are covered by unit tests, fuzz tests (including a dedicated test that the
circuit breaker cannot be bypassed), invariant tests and fork tests against Celo mainnet state. Use at your own
risk until an external audit is published.

## Design invariants

1. **Identity boundary.** Staking, claiming earnings, registering an AI agent and buying a module require
   `IdentityV4.getWhitelistedRoot(msg.sender) != address(0)` in the same block. The GoodID root is the
   unique-human key. Stake withdrawals do not require identity, so users always recover their own deposit.
2. **Solvency.** `G$.balanceOf(core) >= accountedBalance()` at all times. The accounted balance is the sum of
   campaign escrow, unclaimed epoch liabilities, stakes, the rewards pool and pending fee revenue.
3. **Rolling-window breaker.** No 24 consecutive hourly buckets ever release more than `maxRollingOutflow`.
   There are no fixed-window resets.
4. **UBI share.** Exactly 20% (`UBI_SHARE_BPS = 2000`, constant) of every platform fee goes to GoodDollar's
   UBIScheme in the settlement transaction.
5. **Pause and veto.** The guardian role can pause and veto an epoch. Only the admin Safe can unpause or
   re-root. Merkle amounts are cumulative, so re-rooting never double-pays.
6. **No external callbacks.** Payouts use plain ERC-20 transfers. There are no Superfluid Super Apps and no DEX
   dependency.

## Known token-level risks

G$ is upgradeable and governed by the GoodDollar DAO, which can pause transfers, blocklist addresses, burn
balances and enable transfer fees. VeriWork credits deposits by balance delta and uses pull payments so that one
blocked address cannot block others. A token-level pause halts VeriWork's transfers until GoodDollar resumes.
