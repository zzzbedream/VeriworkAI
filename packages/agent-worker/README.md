# @veriwork/agent-worker

The off-chain worker of VeriWork AI on Celo mainnet. It runs the AI contributor and the automation
around the `VeriWorkCore` and `AgentRegistry` contracts:

- publishes funded campaigns as batches (`openBatch` → AI drafts signed by the agent key →
  `markInHumanReview`);
- closes reviewed batches (`markConsensus`) and settles each Wallet Week as a merkle epoch
  (`settleEpoch`, with 20% of the fees routed to the GoodDollar UBI pool in the same transaction);
- slashes the weekly stake of roots with a QA reject rate above 50%;
- marks the Wallet Week UBI-claim bits, indexes on-chain events, relays gas top-ups through the
  GoodDollar Faucet, and sends Telegram reminders;
- watches the G$ price, the rolling outflow breaker and every posted epoch, and pauses or vetoes
  with the guardian key when something is wrong.

Every value rule (pay rules, week math, merkle leaves, fees) comes from `@veriwork/shared`, and every
database access goes through the `@veriwork/database` repositories.

## Running it

```bash
pnpm --filter @veriwork/agent-worker build      # dist/index.js and dist/seed-demo.js

node packages/agent-worker/dist/index.js --once            # every due job once, then exit
node packages/agent-worker/dist/index.js --once --dry-run  # same, but read-only
WORKER_MODE=daemon node packages/agent-worker/dist/index.js # croner schedules (persistent host)

pnpm --filter @veriwork/agent-worker seed:demo -- --dry-run # print the demo seed plan
```

The worker never loads a `.env` file on its own: pass variables through the environment (or
`node --env-file=<file>`).

| Mode                                          | What it does                                                                                                                                                                                                                                                          |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--once` (or `WORKER_MODE=once`, the default) | Runs every enabled job that is **due** a single time, in a fixed order, and exits `0`, or `1` if any job failed (`2` on bad flags or configuration). Each job decides "due" from the database and the chain, so the GitHub Actions cron can call it every 15 minutes. |
| `WORKER_MODE=daemon`                          | Schedules every enabled job with croner (UTC, a job never overlaps itself). SIGTERM / SIGINT stop the schedules and wait up to 30 s for runs in flight.                                                                                                               |
| `--dry-run` (or `DRY_RUN=true`)               | Implies `--once`. Reads the database and the chain, logs what it would do, and never sends a transaction or a message, and never writes the database.                                                                                                                 |

## Jobs

`--once` runs them in this order (state first, safety next, then the pipeline).

| Job                | Daemon schedule (UTC) | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------ | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `indexer`          | every 30 s            | `getLogs` in ranges of at most 2,000 blocks from a checkpoint: VeriWork events, G$ `Transfer` logs to or from a VeriWork contract, and `WhitelistedAdded` of known users. Stores `txFrom` / `txTo`, then mirrors campaign funding, stakes, claims, epoch status, agent status and pauses into the database.                                                                                                            |
| `price-sentinel`   | every minute          | Mento reserve price every run, CoinGecko (Demo key) at most every 5 minutes. A reserve drop above `SENTINEL_PRICE_DROP_PCT` within `SENTINEL_WINDOW_MINUTES` pauses the core and the registry; a CoinGecko drop pauses only when the reserve also fell more than `SENTINEL_CORROBORATION_PCT`, otherwise it is a warning. In `--once` mode the window covers at least 35 minutes, so the previous run's sample counts. |
| `outflow-sentinel` | every minute          | Rolling outflow over its 24 h cap, for the core and the registry: above `SENTINEL_OUTFLOW_WARN_PCT` warns, at `SENTINEL_OUTFLOW_PAUSE_PCT` pauses. Alerts when GoodDollar pauses G$ or blocks a VeriWork contract.                                                                                                                                                                                                     |
| `epoch-watchtower` | every minute          | Recomputes every open, posted epoch from the database (merkle root, total, and each allocation against the batch work). A mismatch vetoes the epoch and raises a critical alert.                                                                                                                                                                                                                                       |
| `faucet-relayer`   | every 30 s            | Leases `GasTopUp` requests, re-checks the GoodID root, the CELO balance (< 0.21) and `Faucet.canTop`, then sends `Faucet.topWallet(user)` from the operator key. Not run in dry-run (leasing writes the database).                                                                                                                                                                                                     |
| `trial-conversion` | every 5 min           | Converts trial wallets that passed GoodID (re-checked on-chain) and raises a critical alert, once per submission, for self-reviewed trial work whose batch was already frozen.                                                                                                                                                                                                                                         |
| `orchestrator`     | every minute          | Publishes the DRAFT batches of funded campaigns: `openBatch` (only when the campaign's on-chain funds cover the worst-case reservation), drafts every item with the configured provider, signs each draft, then `markInHumanReview` with a QA-close deadline. At most `AI_MAX_DRAFTS_PER_RUN` drafts per run.                                                                                                          |
| `consensus`        | every minute          | Finalizes submissions that reached their QA quorum, then freezes each ready batch (all items resolved, or past its deadline) and sends `markConsensus` with the frozen payout and results hash. A batch frozen under the previous pay rules is cancelled (`cancelBatch`).                                                                                                                                              |
| `wallet-week`      | every 15 min          | Marks the UBI-claim bit of the day of `UBIScheme.lastClaimed(root)` (12:00 UTC day boundaries) on every wallet of each verified root.                                                                                                                                                                                                                                                                                  |
| `settlement`       | Saturday 12:30        | Settles the current week from Saturday 12:30 and the previous week if it was never posted (the contract accepts a week until the Monday after the next one). Reads the on-chain epoch first, builds the allocations (batch work plus the five-day bonus from the rewards pool), checks them with `checkEpochConsistency` against `maxEpochTotal`, stores the draft and every proof, then sends `settleEpoch`.          |
| `stakes`           | Saturday 13:00        | Inside the slash window, slashes 25% of the stake of every root whose QA reject rate for the week is above 50%. Reads the stake first, so a root is never slashed twice.                                                                                                                                                                                                                                               |
| `notifications`    | every 5 min           | Telegram only (skipped without `TELEGRAM_BOT_TOKEN`): UBI reminder after the 12:00 UTC reset, GoodID expiry (24 h before a 3-day window ends, 7 days before a 180-day window ends), the Friday bonus, claimable earnings. Deduped through `NotificationLog`, sent through a queue of at most 25 messages per second and one per chat per second.                                                                       |

Alerts (WARNING and CRITICAL) are stored in `AlertLog` and forwarded to `TELEGRAM_ADMIN_CHAT_ID`;
the same alert is sent at most once per hour. Guardian pauses and vetoes are written to
`GuardianAction` (PENDING → SENT → CONFIRMED, or SKIPPED / FAILED).

## Transactions

Every write goes through one `TxSender` per key:

- explicit EIP-1559 fees: `maxFeePerGas` = max(2 × base fee + tip, 250 gwei), tip 2 gwei;
- one transaction at a time per key, and none while the key already has one pending;
- simulated first, so a revert is decoded into a stable key (`G_DOLLAR_PAUSED`,
  `EPOCH_NOT_SETTLEABLE`, ...) instead of being paid for;
- signed locally, broadcast, the hash persisted in the database, and only then the receipt awaited
  (with `TX_RECEIPT_TIMEOUT_SECONDS`).

Each job reads the contract state before writing, and resumes from a persisted hash (waits for it
while pending, reuses it once mined, sends again only if it vanished). A run that crashes at any
step therefore continues on the next run without sending a duplicate.

## AI drafts

`AI_PROVIDER=fixture` (the default) drafts offline: the curated items of `src/demo/dataset.json`
get their pre-written, deliberately imperfect drafts; any other item gets a naive heuristic draft.

`AI_PROVIDER=anthropic` drafts with Claude through the Messages API (`AI_MODEL`, default
`claude-opus-5-5`, with an explicit `AI_EFFORT`): a structured JSON output built from the shared
output schema and validated again with `parseTaskOutput`, the static system prompt cached with
`cache_control`, and the server-side refusal fallback. Refusals, truncations, invalid output, rate
limits and outages are typed errors: retryable ones are retried on the next run; an item the model
will not draft is published without a draft (and alerted).

The agent key signs `keccak256(canonicalJSON(output))` of every draft as an EIP-191 personal
message (`signMessage({ message: { raw: hash } })`); `recordAiDraft` re-checks the hash.

## Demo seed

`seed:demo` creates the grant-funded demo campaigns from `src/demo/dataset.json` (EN→ES translation
validation, sentiment labels, RLHF preference pairs; 10 items each) through the admin path: Pilot QA
(one voter), 100 G$ per accepted item, 20 G$ per honest review, 10 G$ per honest QA vote. Each
campaign is funded with the worst case: per item `100 + 2 × (20 + 1 × 10) = 160 G$`, 1,600 G$ per
campaign plus the 10% fee, 1,760 G$ per campaign and 5,280 G$ in total.

On-chain, only what is missing: the operator grants itself `SPONSOR_ROLE` (it administers that
role), funds each campaign (EIP-2612 permit + `fundCampaignWithPermit` when the G$ domain matches,
else an exact `approve` + `fundCampaign`, both with `maxFeeBps` = 1000), then `openBatch`, the
signed drafts and `markInHumanReview`. Campaign ids are deterministic, so a re-run (even on a fresh
database) finds what an earlier run already funded. Transaction hashes and the funding events are
stored in the database.

```bash
pnpm --filter @veriwork/agent-worker seed:demo -- --dry-run
pnpm --filter @veriwork/agent-worker seed:demo -- --dry-run --operator-address 0x...  # plan without the key
pnpm --filter @veriwork/agent-worker seed:demo -- --review-weeks 2                    # execute
```

## Environment variables

| Variable                                                   | Default                         | Notes                                                                    |
| ---------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------ |
| `DATABASE_URL`                                             | required                        | PostgreSQL (secret)                                                      |
| `CHAIN_ID`                                                 | `42220`                         | `42220`, `11142220` or `31337` (anvil fork)                              |
| `CELO_RPC_URL`                                             | forno                           | primary RPC; a URL with a key is treated as a secret                     |
| `CELO_RPC_FALLBACK_URLS`                                   |                                 | comma-separated; forno is always the last fallback                       |
| `VERIWORK_CORE_ADDRESS`, `AGENT_REGISTRY_ADDRESS`          | v2 mainnet                      | deployment overrides                                                     |
| `OPERATOR_PRIVATE_KEY`                                     |                                 | secret; `OPERATOR_ROLE`: pipeline, settlement, slashing, faucet relaying |
| `GUARDIAN_PRIVATE_KEY`                                     |                                 | secret; `GUARDIAN_ROLE`: pause and veto only                             |
| `AI_AGENT_PRIVATE_KEY`                                     |                                 | secret; signs drafts, never sends transactions                           |
| `WORKER_MODE`                                              | `once`                          | `once` or `daemon`                                                       |
| `DRY_RUN`                                                  | `false`                         | same as `--dry-run`                                                      |
| `LOG_LEVEL`                                                | `info`                          | pino level (`silent` to mute)                                            |
| `WEB_APP_URL`                                              | `https://veriworkai.vercel.app` | links in notifications                                                   |
| `WORKER_ENABLE_PIPELINE`                                   | `true`                          | orchestrator, consensus, trial conversion (operator + agent keys)        |
| `WORKER_ENABLE_SETTLEMENT`                                 | `true`                          | settlement and slashing (operator key)                                   |
| `WORKER_ENABLE_WALLET_WEEK`                                | `true`                          | UBI-claim bits                                                           |
| `WORKER_ENABLE_INDEXER`                                    | `true`                          | indexer                                                                  |
| `WORKER_ENABLE_SENTINEL`                                   | `true`                          | price and outflow sentinels, epoch watchtower (guardian key)             |
| `WORKER_ENABLE_TELEGRAM`                                   | `true`                          | notifications (also needs `TELEGRAM_BOT_TOKEN`)                          |
| `WORKER_ENABLE_FAUCET_RELAYER`                             | `true`                          | faucet relayer (operator key)                                            |
| `AI_PROVIDER`                                              | `fixture`                       | `fixture` or `anthropic`                                                 |
| `ANTHROPIC_API_KEY`                                        |                                 | secret; required with `AI_PROVIDER=anthropic`                            |
| `AI_MODEL`                                                 | `claude-opus-5-5`               |                                                                          |
| `AI_EFFORT`                                                | `medium`                        | `low`, `medium`, `high`, `xhigh`, `max`                                  |
| `AI_MAX_TOKENS`                                            | `16000`                         | thinking counts toward it                                                |
| `AI_MAX_DRAFTS_PER_RUN`                                    | `25`                            |                                                                          |
| `AI_CONCURRENCY`                                           | `2`                             |                                                                          |
| `COINGECKO_API_KEY`                                        |                                 | secret (Demo key); without it CoinGecko is not sampled                   |
| `SENTINEL_PRICE_DROP_PCT`                                  | `15`                            |                                                                          |
| `SENTINEL_WINDOW_MINUTES`                                  | `10`                            |                                                                          |
| `SENTINEL_CORROBORATION_PCT`                               | `5`                             | reserve drop needed before a CoinGecko drop pauses                       |
| `SENTINEL_OUTFLOW_WARN_PCT` / `SENTINEL_OUTFLOW_PAUSE_PCT` | `80` / `95`                     |                                                                          |
| `SENTINEL_COINGECKO_INTERVAL_MINUTES`                      | `5`                             |                                                                          |
| `GUARDIAN_COOLDOWN_MINUTES`                                | `10`                            | between two guardian attempts on the same target                         |
| `TELEGRAM_BOT_TOKEN`                                       |                                 | secret; notifications are skipped when unset                             |
| `TELEGRAM_ADMIN_CHAT_ID`                                   |                                 | receives WARNING / CRITICAL alerts                                       |
| `INDEXER_START_BLOCK`                                      | v2 deploy block                 | first block indexed when there is no checkpoint                          |
| `INDEXER_MAX_CHUNKS_PER_RUN`                               | `20`                            | 2,000-block ranges per run                                               |
| `INDEXER_CONFIRMATIONS`                                    | `30`                            | blocks kept behind the head (forno nodes can trail it)                   |
| `BATCH_REVIEW_WEEKS` / `BATCH_MIN_REVIEW_HOURS`            | `1` / `24`                      | batch deadline: the Saturday 12:00 UTC QA close at least this far out    |
| `TX_RECEIPT_TIMEOUT_SECONDS`                               | `120`                           |                                                                          |

The operator, guardian and agent keys must be three different keys. Logs are JSON (pino):
secret-named fields are censored and every configured secret value (keys, tokens, the database URL,
RPC URLs with credentials) is scrubbed from messages, fields and error stacks.

## GitHub Actions

- `.github/workflows/worker-cron.yml` runs `--once` every 15 minutes. A manual run defaults to a
  dry run.
- `.github/workflows/worker-seed-demo.yml` runs `seed:demo` on demand, a dry run by default.

Both only run from the default branch, share one concurrency group (one operator key, one nonce
sequence), pin every action to a commit SHA and expose secrets only to their final step. They need
the repository variables `WORKER_CRON_ENABLED` / `SEED_DEMO_ENABLED` set to `true`.

## Tests

```bash
pnpm --filter @veriwork/agent-worker test       # vitest + coverage (>= 80%)
pnpm --filter @veriwork/agent-worker typecheck
pnpm --filter @veriwork/agent-worker lint
```

The tests need no network: chain calls go to an in-memory fake JSON-RPC (a viem custom transport
that simulates VeriWorkCore, G$ with EIP-2612, Identity, UBIScheme, the Faucet and Mento), and the
database is a throwaway `@prisma/dev` PostgreSQL started once per run (pinned to `127.0.0.1`).
