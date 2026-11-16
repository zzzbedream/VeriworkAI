# @veriwork/contracts

Solidity contracts for VeriWork AI on **Celo mainnet (chainId 42220)**. VeriWork pays verified humans in G$ for AI
training micro-work (RLHF, translation validation, labeling). Every paid action is gated by GoodDollar identity, and
20% of every platform fee goes to the GoodDollar UBI pool.

Foundry · solc `0.8.38` · `evm_version = "prague"` (Celo has no Osaka opcodes) · OpenZeppelin Contracts `v5.6.1` ·
forge-std `v1.16.2`. The contracts are not upgradeable: a new version is a new deployment.

## Contracts

| File | Purpose |
|---|---|
| `src/VeriWorkCore.sol` | B2B campaign escrow, the batch pipeline (AI draft → human review → QA consensus → settled), weekly merkle epochs claimed by workers, the refundable weekly stake, upskill modules, fee routing |
| `src/core/CoreParameters.sol` | The core's admin-set parameters (recipients, fee, stake, claim timing, epoch cap, rolling cap), their bounds and setters |
| `src/AgentRegistry.sol` | AI contributors bonded in G$ by a verified human, with the agent's EIP-712 consent. The bond can be slashed for poor QA outcomes, and the slash goes to UBI |
| `src/security/RollingWindowBreaker.sol` | Caps G$ outflow over any rolling window of 24 hourly buckets |
| `src/security/GuardianPausable.sol` | Roles: admin, guardian (pause/veto only), operator (workflow) |
| `src/libraries/IdentityLib.sol` | `rootOf(identity, account)`. Fails closed and is safe against return bombs |
| `src/libraries/TokenTransfers.sol` | Transfers at par: every pull and push checks the payer's and the payee's balance deltas, so a G$ transfer fee can never take part of anyone's money; front-running-safe permit |
| `src/libraries/WeekMath.sol` | Wallet Week calendar (Monday 12:00 UTC, the UBI day boundary) |
| `src/libraries/FeeMath.sol` | Basis-point math and the fixed 20% UBI split |
| `src/libraries/EpochMerkle.sol` | Epoch leaf, compatible with `@openzeppelin/merkle-tree` |
| `src/interfaces/` | `IVeriWorkCore` (types, errors, events), `IIdentity` (IdentityV4 subset), `IGoodDollar` |
| `scripts/` | `test-fork.mjs` (cross-platform fork-suite runner) and `check-coverage.mjs` (coverage gate) |

External addresses (Celo mainnet): G$ `0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A`, IdentityV4
`0xC361A6E67822a0EDc17D899227dd9FC50BD62F42`, UBIScheme `0x43d72Ff17701B2DA814620735C39C620Ce0ea4A1`.

## Security model and invariants

- **Identity boundary.** Each value action resolves `root = Identity.getWhitelistedRoot(msg.sender)` at the block of
  the action. These actions are stake deposits, claims, agent registrations and module purchases. A zero root, or a
  reverting or malformed Identity response, means "not verified". The root is the key for every per-human limit: one
  stake per week, one trial reward, at most 3 agents, one copy of each module. Tokens always go to `msg.sender`. Refunds
  (stake withdrawal, bond withdrawal) need no identity, so users recover their own funds even after their GoodID
  expires. GoodID expiry is per user (3 days after a first verification, 180 days after the next), so it is never
  cached.
- **G$ is admin-controlled.** The GoodDollar DAO can pause G$, block addresses, burn balances, install a transfer fee
  (`setFormula`; the fee goes to the formula's fee recipient, the GoodDollar Avatar at block 82845950) and upgrade
  the token. The contracts follow from that:
  - **Every transfer moves at par.** `TokenTransfers.pullExact` and `pushExact` measure the payer's and the payee's
    G$ balances before and after each transfer. The payer must lose exactly `amount`, otherwise the transfer reverts
    with `SenderFeeNotSupported(spent, amount)`. The payee must gain at least `amount`, otherwise it reverts with
    `ReceiverFeeNotSupported(received, amount)`. This covers every deposit (stake, bond, module price, campaign and
    rewards-pool funding) and every outflow (claims, refunds, withdrawals, sweeps, slashes and the fee flush). So
    while a fee formula charges VeriWork's transfers, whichever side pays it, those transfers revert. Nobody loses
    part of their money to the fee: no worker, staker, sponsor, agent owner, treasury or UBIScheme. The tokens stay
    where they are and stay accounted, and UBIScheme always receives exactly its 20%. The price is gas: on the real
    G$ (Superfluid balances) the two extra balance reads per transfer add about 100k gas, about 0.02 CELO at
    200 gwei, to each deposit, claim or refund, and about 200k to `settleEpoch`.
  - Earnings, refunds and withdrawals are pulled by their owners and paid with plain `safeTransfer`s. Nothing uses
    `transferAndCall` or ERC777 `send`, which revert for EIP-7702 accounts and contracts.
  - Solvency is `balanceOf(this) >= accountedBalance()` (core) and `balanceOf(this) >= totalBonded` (registry).
    Streams and direct transfers can only add to the balance; the excess is sweepable surplus. No payout recipient
    can be the contract itself (`InvalidRecipient`), since a transfer to itself moves nothing.
- **Rolling-window circuit breaker.** Every G$ outflow passes `_consumeOutflow` (24 hourly buckets). No fixed reset
  exists that an attacker could time. Moving a full cap at 23:59:59 and again at 00:00:01 reverts. Any real-time
  interval of 23 hours or less moves at most one cap. Discretionary outflows in the core (sponsor withdrawals,
  rewards-pool withdrawals and surplus sweeps) may only fill the window up to `DISCRETIONARY_OUTFLOW_BPS` = 30% of
  the cap (`DiscretionaryOutflowLimitExceeded(requested, available)`, see `remainingDiscretionaryCapacity()`). Claims,
  stake refunds and the fee flush therefore always keep at least 70% of the cap.
- **Bounded settlement.** A week can only be settled from its Saturday 12:00 UTC until the end of the following week
  (`[weekStart + 5 days, weekStart + 14 days)`), so an old, unused week id can never be settled. One epoch can commit
  to at most `maxEpochTotal`. Claims open after `claimDelay` (12 h by default), the guardian's veto window.
- **Guardian and admin.** The guardian can pause and veto epochs, nothing else. Only the admin can unpause, re-root
  or cancel a vetoed epoch, change parameters or move pool funds. There are no Superfluid Super App callbacks and no
  Uniswap v4 dependency.
- **Exactly 20% to UBI.** `UBI_SHARE_BPS = 2000` is a constant. `ubi = fee * 2000 / 10000` and
  `treasury = fee - ubi`, so no dust is lost. Settlement sends the share to UBIScheme with a plain transfer in the same
  transaction that settles the batches. Module sales split 20/80, and slashed stakes and bonds go 100% to UBI.
- **Weekly pull settlement.** Nothing is paid per task on-chain. Once per week the operator posts a merkle root of
  cumulative per-account allocations. The leaf is
  `keccak256(bytes.concat(keccak256(abi.encode(epochId, account, amount, trialAmount))))`, which equals the
  `StandardMerkleTree` leaf for `["uint256","address","uint256","uint256"]`. Workers claim before the window closes
  (60 days). Total claims can never exceed the epoch total, even under a faulty tree.
- **Trial escrow.** Pre-verification work is part of `amount` as `trialAmount`. It can only be claimed once the wallet
  is verified. The first wallet of a human to claim trial earnings becomes its trial wallet (`trialWalletOf[root]`):
  that wallet's trial earnings are paid in every epoch, so a two-task trial that settles across two epochs is paid in
  full. Trial earnings of any other wallet of the same root are forfeited to the rewards pool and emit
  `TrialRewardForfeited`.
- **Caller caps.** Prices set by the admin are never charged above what the caller accepted: `depositStake(maxAmount)`,
  `purchaseModule(moduleId, maxPrice)`, `registerAgent(..., maxBond, ...)` and `fundCampaign(..., maxFeeBps)`. The
  permit variants use the signed permit value as the cap.
- **Checks-effects-interactions** applies throughout. `nonReentrant` (transient storage) guards every token-moving
  function. Every state change emits an event.

### Wallet Week (identical in contracts, worker and web)

`weekId = (t - 388800) / 604800`, `weekStart = weekId * 604800 + 388800` (Monday 12:00:00 UTC), `dayIndex = (t -
weekStart) / 86400`. The stake deposit window is `[weekStart, +2d)`. QA closes and slashing opens at `+5d`
(Saturday 12:00 UTC); the week becomes settleable then and stays settleable until `+14d`. Stakes unlock at `+6d`
(Sunday 12:00 UTC).

### Roles

| Role | Holder | Can |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` | Admin (a Safe before sponsor funds) | unpause, re-root or cancel a vetoed epoch, parameters, module prices, rewards-pool withdrawals, surplus sweeps, expired-epoch sweeps, role management, agent reinstate/slash |
| `GUARDIAN_ROLE` | Sentinel hot key | `pause()`, `vetoEpoch()` |
| `OPERATOR_ROLE` | Agent worker | batch transitions, `settleEpoch`, `slashStake`, `sweepExpiredEpoch`, `suspendAgent`; admin of `SPONSOR_ROLE` |
| `SPONSOR_ROLE` (core) | Vetted B2B sponsors | create and fund campaigns (`fundCampaign*`); withdrawing unreserved funds works even after revocation |

Sponsors are onboarded on-chain by the operator (`grantRole(SPONSOR_ROLE, sponsor)`). A campaign's funds can only be
withdrawn `CAMPAIGN_FUNDING_LOCK` (24 hours) after its last funding, and any top-up restarts the lock for the whole
campaign, so funding and withdrawing in one transaction is impossible. The batch pipeline can still reserve the funds
at once. Sponsor withdrawals are also discretionary outflows. A sponsor holding capital equal to the whole rolling cap
can therefore fill at most 30% of the window, never the capacity that claims, refunds and the fee flush rely on. The
same applies to the operator, which administers `SPONSOR_ROLE`.

## Functions

### VeriWorkCore

| Function | Caller | Notes |
|---|---|---|
| `fundCampaign(campaignId, amount, maxFeeBps)` / `fundCampaignWithPermit(campaignId, amount, maxFeeBps, deadline, v, r, s)` | sponsor | pulls exactly `amount`; the first funding snapshots `platformFeeBps` (`PlatformFeeAboveMax` above `maxFeeBps`); restarts the 24 h lock |
| `withdrawCampaign(campaignId, amount)` | campaign sponsor | unreserved funds only; `CampaignFundsLocked(unlockAt)` within 24 h of the last funding; discretionary (30% of the cap) |
| `openBatch`, `markInHumanReview`, `markConsensus`, `cancelBatch` | operator | batch state machine; reserves `maxPayout + fee` and releases what consensus does not use |
| `settleEpoch(epochId, merkleRoot, batchIds, bonusAmount)` | operator | only the closing or previous week (`EpochNotSettleable(epochId, from, until)`); total `<= maxEpochTotal` (`EpochTotalTooLarge`); flushes the 20/80 fee split in the same transaction |
| `vetoEpoch(epochId)` | guardian or admin | blocks claims; works while paused |
| `reRootEpoch(epochId, newRoot)` | admin | vetoed, not cancelled; restarts the claim delay and window; amounts already claimed stay consumed |
| `cancelEpoch(epochId)` | admin | vetoed, not cancelled: the unclaimed remainder returns to the rewards pool at once (`EpochCancelled`); works while paused |
| `claim(epochId, amount, trialAmount, proof)` / `claimMany(requests)` | verified wallet | pays `msg.sender`; trial rule above |
| `sweepExpiredEpoch(epochId)` | operator or admin | after `expiresAt`, never for a vetoed epoch |
| `depositStake(maxAmount)` / `depositStakeWithPermit(value, deadline, v, r, s)` | verified wallet | Monday 12:00 to Wednesday 12:00 UTC, one per human; `StakeAmountAboveMax` above the cap |
| `slashStake(weekId, root, slashBps, reasonHash)` | operator | Saturday 12:00 to Sunday 12:00 UTC, once, `<= 50%`, 100% to UBI; works while paused (it moves no tokens) |
| `withdrawStake(weekId, root)` | depositing wallet | from Sunday 12:00 UTC, no identity check; breaker |
| `purchaseModule(moduleId, maxPrice)` / `purchaseModuleWithPermit(moduleId, value, deadline, v, r, s)` | verified wallet | once per human; `ModulePriceAboveMax` above the cap; 20/80 split |
| `fundRewardsPool(amount)` / `fundRewardsPoolWithPermit(...)` | anyone | pulls exactly `amount` |
| `withdrawRewardsPool(to, amount)` | admin | discretionary (30% of the cap); `to` is neither zero nor the core |
| `flushRevenue()` | anyone | pending UBI and treasury revenue; breaker |
| `sweepSurplus(to, amount)` | admin | `amount <= surplus()` (`InsufficientSurplus`); discretionary, so a large surplus is swept in parts |
| `setPlatformFeeBps`, `setStakeAmount`, `setClaimTiming`, `setMaxEpochTotal`, `setMaxRollingOutflow`, `setUbiRecipient`, `setTreasury`, `setModulePrice` | admin | bounded; the recipients are neither zero nor the core (`InvalidRecipient`); emit `ParameterUpdated` / `RecipientUpdated` / `ModulePriceSet` |

Views: `accountedBalance()`, `surplus()`, `remainingDiscretionaryCapacity()`, `trialWalletOf(root)`,
`trialRewardUsed(root)`, `claimedAmount(epochId, account)`, `claimable(epochId, account, amount)`, `campaign(id)`
(`lastFundedAt` included), `batch(id)`, `epoch(id)`, `stake(weekId, root)`, `hasModule(root, moduleId)`,
`currentWeekId()`, `weekStart(weekId)`, `dayIndex()`, plus the breaker views `rollingOutflow()` and
`remainingOutflowCapacity()`.

### AgentRegistry

| Function | Caller | Notes |
|---|---|---|
| `registerAgent(agent, metadataHash, maxBond, consentDeadline, consentSignature)` | verified wallet | needs the agent's consent (below); `BondAboveMax` above `maxBond`; one registration per agent address ever; at most 3 non-withdrawn agents per human |
| `registerAgentWithPermit(agent, metadataHash, consentDeadline, consentSignature, value, deadline, v, r, s)` | verified wallet | the signed permit `value` is the bond cap |
| `requestUnbond(agent)` / `withdrawBond(agent)` | owner wallet | 7-day delay; no identity check on withdrawal; breaker |
| `suspendAgent(agent, reasonHash)` | operator | Active → Suspended; works while paused |
| `reinstateAgent(agent)` | admin | Suspended → Active, only while the agent still has a bond (`AgentHasNoBond`) |
| `slashAgent(agent, amount, reasonHash)` | admin | to UBI through the breaker; a slash that empties the bond of an Active agent suspends it |
| `sweepSurplus(to, amount)` | admin | only G$ above `totalBonded`; `to` is neither zero nor the registry; breaker |
| `setBondAmount`, `setMaxRollingOutflow`, `setUbiRecipient` | admin | bounded; the UBI recipient is neither zero nor the registry (`InvalidRecipient`) |

Views: `agent(agent)`, `isActiveAgent(agent)` (Active, bonded and the owner still resolves to the same root),
`activeAgentCount()` (every counted agent is bonded), `agentsOfRoot(root)`, `surplus()`, `consentDigest(owner,
metadataHash, deadline)`, `eip712Domain()`, `AGENT_CONSENT_TYPEHASH`.

**Agent consent.** The agent key signs the EIP-712 message `AgentConsent(address owner,bytes32 metadataHash,uint256
deadline)` with domain `{name: "VeriWork AgentRegistry", version: "1", chainId, verifyingContract: AgentRegistry}`,
where `owner` is the wallet that will call `registerAgent`. The signature is first checked as an ECDSA signature by
the agent key, so an EOA agent can still consent with its key after an EIP-7702 delegation gives it code. Otherwise an
agent with code must approve the digest through ERC-1271 (smart-account agents). The consent is void after `deadline`
(`ConsentExpired`), and a wrong signer, owner, card, chain or registry reverts with `InvalidConsent(agent)`. No nonce
is needed because an agent address can only ever be registered once.

For the agent worker: use a plain EOA agent key, or a contract wallet whose `isValidSignature` is sound. The registry
takes an ERC-1271 answer as given. Anyone can therefore bond a contract that approves every digest (for example one
whose fallback echoes the selector), and because an address registers only once, its real controller could not
register it afterwards.

## Trust assumptions

These are known and accepted for the demo phase:

- **Operator for settlement.** The operator key decides what an epoch pays. Its reach is bounded by the settlement
  window, `maxEpochTotal`, the claim delay during which the guardian or the admin can veto (and the admin can cancel or
  re-root), and the rolling breaker. Run the epoch watchtower and the guardian key independently of the worker.
- **Slashing works while paused.** That way a pause on Saturday does not lose the slash window. It also means a
  guardian pause alone does not stop a compromised operator from slashing stakes. The damage is bounded: at most 50% of
  each stake, once per week, only from Saturday 12:00 to Sunday 12:00 UTC, and the slashed G$ go to UBIScheme, not to
  the attacker. No function undoes a slash. Revoke `OPERATOR_ROLE` together with the pause (see the runbook).
- **Single admin key during the demo.** The admin is one founder key until the contracts hold sponsor funds; move
  `DEFAULT_ADMIN_ROLE` to a Safe before that (`grantRole` to the Safe, then `renounceRole`). Losing the admin key
  while paused would freeze withdrawals, because only the admin can unpause.
- **Immediate parameter changes.** Raising `maxRollingOutflow`, `maxEpochTotal` or a price takes effect at once (there
  is no delay); callers are protected by their own caps, and pools by the admin's custody.
- **GoodDollar connected accounts.** IdentityV4 `connectAccount` needs no consent from the connected address, so a
  verified human can attach a wallet whose own GoodID is not live, and that wallet's value actions then count against
  the attaching root. A wallet can disconnect itself with `disconnectAccount`. Forfeited trial earnings are always
  evented (`TrialRewardForfeited`), so the app can show them and offer the disconnection.
- **G$ fee formula: liveness, not funds.** A formula that charges VeriWork's transfers makes every deposit and payout
  revert until the DAO removes it or exempts VeriWork's addresses (a formula sees the sender and the recipient).
  Funds stay safe and accounted, and nobody pays the fee. Nothing moves meanwhile, though: no settlement (its fee
  flush is a transfer), no claims and no refunds. If the DAO made a fee permanent without exempting VeriWork, the
  tokens would stay locked until it does. By design there is no override that would let anyone accept a fee on
  someone else's behalf. The sentinel watches the formula, and the deployment script refuses to deploy while the live
  formula would charge VeriWork's transfers.
- **Superfluid accounts with a negative balance.** G$ `balanceOf` floors at zero. A recipient whose outgoing streams
  have pushed its available balance below zero therefore cannot be paid in full until it is solvent again. Its own
  claims or refunds revert with `ReceiverFeeNotSupported`, and nobody else is affected.
- **Off-chain rules.** The two-task trial limit, QA consensus and the pay rules are enforced off-chain; the contracts
  bound what any tree can pay.

## Testing

```bash
forge build --sizes          # both contracts are under 24,576 bytes (core 21,955, registry 12,126)
forge test                   # unit, fuzz and invariant suites (fork suite is skipped)
forge fmt --check
pnpm test:fork               # fork suite; sets RUN_FORK_TESTS=true on every platform and fails if anything skips
pnpm coverage:check          # forge coverage + gate: >= 80% lines and branches for src/ (CI runs the same gate)
FOUNDRY_PROFILE=ci forge test   # 10k fuzz runs, deeper invariant campaigns
```

Fork tests run against real Celo mainnet state (G$, IdentityV4, UBIScheme) at block **82845950**. Without
`pnpm test:fork` (or `RUN_FORK_TESTS=true`) they are skipped. `CELO_RPC_URL` overrides the default
`https://forno.celo.org`; responses are cached after the first run. They fund accounts by impersonating a G$ holder;
`deal()` is never used on G$, because Superfluid balances are not plain storage. For long time spans they use
`vm.mockCall` on Identity, since warping far ahead expires real identities.

| Suite | Covers |
|---|---|
| `test/unit/VeriWorkCore*.t.sol` | constructor, roles, setters and bounds (no self recipient), pause coverage, campaigns (fee cap, 24 h lock, the discretionary 30% share, a sponsor with capital equal to the cap), batch transitions and reservation math, settlement window and epoch cap, claims (root, connected wallet, expired, unverified, bad proof, double claim, over-claim, re-root top-up), the trial wallet across epochs, veto, re-root, cancel, sweep roles, stake windows on each UBI day, caps, slash while paused, modules, flush, rewards pool, partial surplus sweeps, sender-pays and receiver-pays fees failing closed on every deposit and payout, permits, reentrancy |
| `test/unit/AgentRegistry*.t.sol` | registration with consent (EOA, ERC-1271 and an EIP-7702 delegated agent, wrong signer/owner/card/chain/registry, expiry, front-running), bond cap, per-human cap across wallets, unbonding, withdrawal, suspend, reinstate, full slash suspends, every status guard, breaker cap, surplus sweep, no self recipient, both kinds of fees failing closed, `isActiveAgent` after owner expiry or reconnection |
| `test/unit/TokenTransfers.t.sol` | at-par pulls and pushes: sender-pays and receiver-pays fees revert (fuzzed), a payee that is itself the fee recipient is paid in full, permit variants |
| `test/unit/MerkleCompat.t.sol` | `test/fixtures/merkle-epoch.json` (generated with `@openzeppelin/merkle-tree`; do not edit) verifies against the contract leaf and pays out end to end |
| `test/unit/DeployScript.t.sol` | deployment on the local chain (admin hand-off, module prices, record) and every configuration check: canonical protocol addresses, distinct roles, a multisig Safe admin on mainnet (an EOA, an EIP-7702 account or a 1-of-N Safe needs `ALLOW_EOA_ADMIN`; a contract that is not a Safe is rejected), the G$ fee gate |
| `test/fuzz/` | `testFuzz_RollingWindowBreakerCannotBeBypassed` (100 fuzzed withdrawals against a ghost ledger, plus the fixed-reset exploit) and the exact 20% fee split |
| `test/invariant/CircuitBreaker.invariant.t.sol` | core random walk, including settlement of the previous week, veto + cancel, donations swept in part, rewards-pool withdrawals, epoch-cap changes, pause/unpause and a G$ fee switch (none, sender-pays, receiver-pays). Invariants: solvency; rolling window ≤ cap; discretionary outflows never leave the window above 30% of the cap; UBI == 20% of fees + 20% of modules + 100% of slashes (expected values, not read back); no G$ fee is ever collected on a VeriWork transfer; no unverified claim; escrow, epoch liability and stake ledgers match the handler's records |
| `test/invariant/AgentRegistry.invariant.t.sol` | registry random walk with the same fee switch. Invariants: `balanceOf >= totalBonded == Σ bonds`; `activeAgentCount == #Active` and every Active agent is bonded; `agentsOfRoot` matches and stays ≤ 3; UBI == requested slashes; no G$ fee is ever collected |
| `test/fork/CeloMainnetFork.t.sol` | full flow on mainnet state; the exact 20% UBI delta measured within one block; claims by a root, a connected wallet and an EIP-7702 account; the settlement window; a trial split across two epochs; at-par transfers against real G$ fee formulas installed by the Avatar (sender-pays and receiver-pays: payouts and deposits revert, the fee recipient collects nothing); permit stake with a fresh key; agent consent with a fresh key; blocked recipients; agent expiry and slash |

## Deploying

`script/DeployCeloMainnet.s.sol` deploys both contracts deterministically with CREATE2. It sets module prices (1 → 100
G$, 2 → 150 G$, 3 → 200 G$). The broadcaster is the core's temporary admin; the script grants `DEFAULT_ADMIN_ROLE` to
the admin and renounces its own role. The registry is deployed with the admin directly. Before deploying, the script
validates the configuration; afterwards it checks every role and parameter (on mainnet against the canonical
GoodDollar addresses, not the configuration) and writes `deployments/<chainId>.json` (addresses, block, deployer,
salt, parameters). A simulation writes `deployments/<chainId>.dry-run.json` instead, which git ignores.

On mainnet the post-deployment checks also read the live G$ fee formula: `getFees(1000 G$, sender, recipient)` for
deposits into and payouts from both contracts. If any of them would pay a fee, the check fails with `G$ transfer
fee`, because VeriWork could not move G$ under that formula. Forge runs the whole script, checks included, before it
broadcasts anything, so a failing check sends no transaction.

| Env | Default / rule |
|---|---|
| `DEPLOYER_PRIVATE_KEY`, `ADMIN_ADDRESS`, `GUARDIAN_ADDRESS`, `OPERATOR_ADDRESS`, `TREASURY_ADDRESS` | required; admin, guardian and operator must be three different addresses |
| `CORE_MAX_ROLLING_OUTFLOW`, `REGISTRY_MAX_ROLLING_OUTFLOW`, `MAX_EPOCH_TOTAL` | required on 42220; `200000e18`, `10000e18`, `100000e18` on test chains. Size the caps at about 1.5 to 2 times the Sunday 24 h peak; sponsor and admin withdrawals get 30% of the core cap. Size `MAX_EPOCH_TOTAL` at about the largest expected weekly payout |
| `G_TOKEN`, `IDENTITY`, `UBI_RECIPIENT` | G$, IdentityV4, UBIScheme. Required on Celo Sepolia. On 42220 any other value is rejected unless `ALLOW_PROTOCOL_OVERRIDE=true`. The UBI recipient must have code on every chain |
| `ALLOW_EOA_ADMIN` | `false`. On 42220 `ADMIN_ADDRESS` must be a Safe with threshold >= 2 (its threshold and owner count are logged). A single key (an EOA, an EIP-7702 account or a Safe with threshold 1) needs `ALLOW_EOA_ADMIN=true`, for the demo phase's founder key, and reverts with `SingleKeyAdmin` otherwise. A contract that is not a Safe is always rejected (`AdminNotSafe`) |
| `PLATFORM_FEE_BPS`, `STAKE_AMOUNT`, `AGENT_BOND` | `1000`, `150e18`, `250e18` |
| `DEPLOY_SALT` | `keccak256("VeriWork.v2")` |

Allowed chains: 42220 (Celo mainnet), 11142220 (Celo Sepolia), 31337 (an anvil fork of mainnet).

```bash
# 1. simulate against live state (no transactions are sent)
forge script script/DeployCeloMainnet.s.sol --fork-url https://forno.celo.org -vvv

# 2. broadcast and verify on Celoscan (Etherscan API v2 supports chainid 42220)
forge script script/DeployCeloMainnet.s.sol --rpc-url celo --broadcast \
  --verify --verifier etherscan --etherscan-api-key "$ETHERSCAN_API_KEY"

# 3. verify on Blockscout as well
forge script script/DeployCeloMainnet.s.sol --rpc-url celo --resume \
  --verify --verifier blockscout --verifier-url https://celo.blockscout.com/api/
```

To verify one contract by hand, use the constructor arguments from the deployment record. Note that the core's
`admin` argument is the deployer address:

```bash
forge verify-contract <address> src/VeriWorkCore.sol:VeriWorkCore --chain 42220 \
  --verifier blockscout --verifier-url https://celo.blockscout.com/api/ \
  --constructor-args "$(cast abi-encode 'constructor(address,address,address,address,address,address,address,uint256,uint256,uint16,uint256)' \
     <G$> <Identity> <deployer> <guardian> <operator> <treasury> <ubiRecipient> <maxOutflow> <maxEpochTotal> <feeBps> <stake>)"
```

A mainnet simulation uses about 11.3M gas including Foundry's 30% estimate buffer (about 8.7M without it; the core's
CREATE2 alone has a 7.07M gas limit). At the 200 gwei base fee the deployment costs about 1.75 CELO. Forge prices it
at about 4.5 CELO because it assumes twice the base fee, so fund the deployer with about 5 CELO; the unused part stays
with the deployer.

After deploying, run `pnpm abi:generate` from the repository root. It regenerates the TypeScript ABIs from
`out/VeriWorkCore.sol/VeriWorkCore.json` and `out/AgentRegistry.sol/AgentRegistry.json`.

## Operational notes

- Settle each week between its Saturday 12:00 UTC and the end of the following week. Batches that reach consensus
  later roll into a later epoch.
- Settlement reverts when the revenue flush would exceed the rolling cap, a recipient is blocked by G$, or a G$ fee
  formula charges the transfer (on either side). Fix the cause or wait for capacity; pending revenue is never lost.
- Unclaimed epoch funds return to the rewards pool via `sweepExpiredEpoch` (operator or admin, after expiry). Do not
  sweep while claims fail for outside reasons (G$ paused or blocking the core, an Identity outage): veto instead. A
  vetoed epoch is never swept.
- A vetoed epoch is either re-rooted (the same root just restarts the claim window, for example after a long pause;
  a corrected root tops accounts up) or, when it is wrong as a whole, cancelled with `cancelEpoch`, which returns its
  unclaimed remainder to the rewards pool. Refund sponsors from there with `withdrawRewardsPool`.
- The claim window keeps running while the contract is paused. To give workers a fresh window after a long pause,
  veto the epoch and re-root it with the same root (both work while paused).
- Stake slashing works while paused, so a pause on Saturday does not lose the slash window.
- Sponsor withdrawals, rewards-pool withdrawals and surplus sweeps share 30% of the core's rolling cap. Large refunds
  go out over several days; `remainingDiscretionaryCapacity()` shows what can move now.

### Incident runbook

- **Compromised operator key.** The admin revokes `OPERATOR_ROLE` on both contracts in the same batch as the pause,
  because slashing works while paused. If the operator granted `SPONSOR_ROLE` to anyone, the admin revokes those
  grants too.
- **Hostile sponsor.** The operator or the admin revokes its `SPONSOR_ROLE`. Its withdrawals are already limited to
  30% of the rolling cap, so claims and refunds keep working meanwhile.
- **G$ fee formula installed.** Nothing to do on-chain: every transfer that would pay a fee reverts and the ledgers
  stay intact. Tell users that G$ movements are on hold because of the G$ fee, and ask the GoodDollar DAO to remove
  the fee or exempt VeriWork's addresses. If a claim window would run out meanwhile, veto that epoch (never sweep it)
  and re-root it later with the same root.
- **Any pause.** Only the admin can unpause, so keep the admin Safe signers reachable.
