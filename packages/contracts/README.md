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
| `src/AgentRegistry.sol` | AI contributors bonded in G$ by a verified human. The bond can be slashed for poor QA outcomes, and the slash goes to UBI |
| `src/security/RollingWindowBreaker.sol` | Caps G$ outflow over any rolling window of 24 hourly buckets |
| `src/security/GuardianPausable.sol` | Roles: admin Safe, guardian (pause/veto only), operator (workflow) |
| `src/libraries/IdentityLib.sol` | `rootOf(identity, account)`. Fails closed and is safe against return bombs |
| `src/libraries/TokenTransfers.sol` | Pulls credited by balance delta, exact pulls for fixed prices, front-running-safe permit |
| `src/libraries/WeekMath.sol` | Wallet Week calendar (Monday 12:00 UTC, the UBI day boundary) |
| `src/libraries/FeeMath.sol` | Basis-point math and the fixed 20% UBI split |
| `src/libraries/EpochMerkle.sol` | Epoch leaf, compatible with `@openzeppelin/merkle-tree` |
| `src/interfaces/` | `IVeriWorkCore` (types, errors, events), `IIdentity` (IdentityV4 subset), `IGoodDollar` |

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
- **G$ is admin-controlled.** The GoodDollar DAO can pause G$, block addresses, burn balances, enable a transfer fee and
  upgrade the token. The contracts follow from that:
  - Funding is credited by balance delta. Fixed prices (stake, bond, module) require the exact amount to arrive.
  - Every payout is a pull made with plain `SafeERC20.safeTransfer`. Nothing uses `transferAndCall` or ERC777 `send`,
    which revert for EIP-7702 accounts and for contracts.
  - Solvency is `balanceOf(this) >= accountedBalance()`, because streams or direct transfers can only add to the
    balance. The excess is sweepable surplus.
- **Rolling-window circuit breaker.** Every G$ outflow passes `_consumeOutflow` (24 hourly buckets). No fixed reset
  exists that an attacker could time. Moving a full cap at 23:59:59 and again at 00:00:01 reverts. Any real-time
  interval of 23 hours or less moves at most one cap.
- **Guardian and admin.** The guardian can pause and veto epochs, nothing else. Only the admin Safe can unpause, re-root
  a vetoed epoch, change parameters or move pool funds. There are no Superfluid Super App callbacks and no Uniswap v4
  dependency.
- **Exactly 20% to UBI.** `UBI_SHARE_BPS = 2000` is a constant. `ubi = fee * 2000 / 10000` and
  `treasury = fee - ubi`, so no dust is lost. Settlement sends the share to UBIScheme with a plain transfer in the same
  transaction that settles the batches. Module sales split 20/80, and slashed stakes go 100% to UBI.
- **Weekly pull settlement.** Nothing is paid per task on-chain. Once per week the operator posts a merkle root of
  cumulative per-account allocations. The leaf is
  `keccak256(bytes.concat(keccak256(abi.encode(epochId, account, amount, trialAmount))))`, which equals the
  `StandardMerkleTree` leaf for `["uint256","address","uint256","uint256"]`. Workers claim after `claimDelay` (12 h,
  the guardian's veto window) and before the window closes (60 days). Total claims can never exceed the epoch total,
  even under a faulty tree.
- **Trial escrow.** Pre-verification work is part of `amount` as `trialAmount`. It can only be claimed once the wallet
  is verified, and it is paid once per human. A second wallet of the same root forfeits its trial part to the rewards
  pool.
- **Checks-effects-interactions** applies throughout. `nonReentrant` (transient storage) guards every token-moving
  function. Every state change emits an event.

### Wallet Week (identical in contracts, worker and web)

`weekId = (t - 388800) / 604800`, `weekStart = weekId * 604800 + 388800` (Monday 12:00:00 UTC), `dayIndex = (t -
weekStart) / 86400`. The stake deposit window is `[weekStart, +2d)`. QA closes and slashing opens at `+5d`
(Saturday 12:00 UTC); the epoch becomes settleable then. Stakes unlock at `+6d` (Sunday 12:00 UTC).

### Roles

| Role | Holder | Can |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` | Admin Safe | unpause, re-root, parameters, module prices, rewards-pool withdrawals, surplus sweep, role management, agent reinstate/slash |
| `GUARDIAN_ROLE` | Sentinel hot key | `pause()`, `vetoEpoch()` |
| `OPERATOR_ROLE` | Agent worker | batch transitions, `settleEpoch`, `slashStake`, `suspendAgent`; admin of `SPONSOR_ROLE` |
| `SPONSOR_ROLE` (core) | Vetted B2B sponsors | create and fund campaigns (`fundCampaign*`); withdrawing unreserved funds works even after revocation |

Sponsors are onboarded on-chain by the operator (`grantRole(SPONSOR_ROLE, sponsor)`). Without this gate anyone could
fund a fresh campaign and withdraw it in the same transaction. That fills the shared rolling cap for 24 hours at no
cost and blocks every claim, refund and settlement. The gate also stops campaign ids being squatted by anonymous
accounts.

## Testing

```bash
forge build --sizes          # both contracts are well under 24,576 bytes
forge test                   # unit, fuzz and invariant suites (fork suite is skipped)
forge fmt --check
forge coverage --report summary --no-match-coverage "(test|script)/"
FOUNDRY_PROFILE=ci forge test   # 10k fuzz runs, deeper invariant campaigns
```

Fork tests run against real Celo mainnet state (G$, IdentityV4, UBIScheme) at block **82845950**. They are skipped
unless enabled:

```bash
RUN_FORK_TESTS=true forge test --match-path "test/fork/*" -vvv
# optional: CELO_RPC_URL=<archive RPC>   (default https://forno.celo.org; responses are cached after the first run)
```

They fund accounts by impersonating a G$ holder; `deal()` is never used on G$, because Superfluid balances are not
plain storage. For long time spans they use `vm.mockCall` on Identity, since warping far ahead expires real
identities.

| Suite | Covers |
|---|---|
| `test/unit/VeriWorkCore*.t.sol` | constructor, roles, setters and bounds, pause coverage, campaigns, batch transitions and reservation math, settlement, claims (root, connected wallet, expired, unverified, bad proof, double claim, over-claim, re-root top-up, trial forfeit), veto, re-root, sweep, stake windows on each UBI day, slash bounds, withdrawal without identity, modules, flush, rewards pool, surplus, permits (including a pre-spent permit), reentrancy |
| `test/unit/AgentRegistry.t.sol` | registration, per-human cap across wallets, unbonding delay, withdrawal, suspend, reinstate, slash, `isActiveAgent` after owner expiry or reconnection |
| `test/unit/MerkleCompat.t.sol` | `test/fixtures/merkle-epoch.json` (generated with `@openzeppelin/merkle-tree`; do not edit) verifies against the contract leaf and pays out end to end |
| `test/unit/DeployScript.t.sol` | deployment script on the local chain: admin handed to the Safe, module prices, config validation, deployment record |
| `test/fuzz/RollingWindowBreaker.t.sol` | `testFuzz_RollingWindowBreakerCannotBeBypassed`: 100 fuzzed withdrawal attempts checked against a ghost ledger, plus a regression test for the fixed-reset exploit |
| `test/fuzz/FeeSplit.t.sol` | `ubi + treasury == fee` and `ubi == fee * 2000 / 10000`, in the library and end to end |
| `test/invariant/CircuitBreaker.invariant.t.sol` | handler-driven random walk. Invariants: solvency; rolling window ≤ cap; UBI received == 20% of fees + 20% of modules + 100% of slashes; no successful claim by an unverified account; ledgers match their sources |
| `test/fork/CeloMainnetFork.t.sol` | full flow on mainnet state; the exact 20% UBI delta measured within one block; claims by a root, a connected wallet and an EIP-7702 account; an expired root reverts; permit stake with a fresh key; blocked recipients; agent expiry and slash |

## Deploying

`script/DeployCeloMainnet.s.sol` deploys both contracts deterministically with CREATE2. It sets module prices (1 → 100
G$, 2 → 150 G$, 3 → 200 G$). The broadcaster is the core's temporary admin; the script grants `DEFAULT_ADMIN_ROLE` to
the Safe and renounces its own role. The registry is deployed with the Safe as admin. The script then checks every role
and parameter and writes `deployments/<chainId>.json` (addresses, block, deployer, salt, parameters). A simulation
writes `deployments/<chainId>.dry-run.json` instead, which git ignores.

| Env | Default |
|---|---|
| `DEPLOYER_PRIVATE_KEY`, `ADMIN_ADDRESS` (Safe), `GUARDIAN_ADDRESS`, `OPERATOR_ADDRESS`, `TREASURY_ADDRESS` | required |
| `UBI_RECIPIENT`, `G_TOKEN`, `IDENTITY` | UBIScheme, G$, IdentityV4 (required on Celo Sepolia) |
| `CORE_MAX_ROLLING_OUTFLOW` / `REGISTRY_MAX_ROLLING_OUTFLOW` | `5000000e18` / `250000e18` |
| `PLATFORM_FEE_BPS`, `STAKE_AMOUNT`, `AGENT_BOND` | `1000`, `150e18`, `250e18` |
| `DEPLOY_SALT` | `keccak256("VeriWork.v1")` |

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
  --constructor-args "$(cast abi-encode 'constructor(address,address,address,address,address,address,address,uint256,uint16,uint256)' \
     <G$> <Identity> <deployer> <guardian> <operator> <treasury> <ubiRecipient> <maxOutflow> <feeBps> <stake>)"
```

A mainnet simulation uses about 9.66M gas, including Foundry's 30% estimate buffer. Forge prices this at about 3.86 CELO,
because it assumes twice the 200 gwei base fee; at the base fee it costs about 1.5 to 2 CELO.

After deploying, run `pnpm abi:generate` from the repository root. It regenerates the TypeScript ABIs from
`out/VeriWorkCore.sol/VeriWorkCore.json` and `out/AgentRegistry.sol/AgentRegistry.json`.

## Operational notes

- The operator posts epoch roots. A compromised operator is bounded by the epoch total and the 12-hour claim delay,
  during which the guardian can veto. The admin can then re-root, and amounts already claimed stay recorded, so the
  new tree only tops accounts up.
- Settlement reverts when the revenue flush would exceed the rolling cap or a recipient is blocked by G$. Fix the
  recipient or wait for capacity; pending revenue is never lost.
- Unclaimed epoch funds return to the rewards pool via `sweepExpiredEpoch` (anyone, after expiry). A vetoed epoch
  is never swept: the admin re-roots it.
- The claim window keeps running while the contract is paused. To give workers a fresh window after a long pause,
  veto the epoch and re-root it with the same root (both work while paused). That restarts `claimableAt` and
  `expiresAt`.
