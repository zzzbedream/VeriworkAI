-- Hand-written defense-in-depth CHECK constraints (Prisma schema cannot express them; Prisma Migrate
-- ignores CHECK constraints when diffing, so they survive future generated migrations).
-- The repositories already enforce every rule atomically; these make a buggy caller fail loudly.

-- Addresses are stored lowercase.
ALTER TABLE "User"
  ADD CONSTRAINT "User_walletAddress_lowercase" CHECK ("walletAddress" ~ '^0x[0-9a-f]{40}$'),
  ADD CONSTRAINT "User_goodIdRoot_lowercase" CHECK ("goodIdRoot" IS NULL OR "goodIdRoot" ~ '^0x[0-9a-f]{40}$'),
  ADD CONSTRAINT "User_reputation_nonnegative" CHECK ("reputation" >= 0);

-- Trial: at most 2 tasks (TRIAL_TASK_LIMIT), escrow never negative.
ALTER TABLE "TrialSession"
  ADD CONSTRAINT "TrialSession_tasksCompleted_range" CHECK ("tasksCompleted" BETWEEN 0 AND 2),
  ADD CONSTRAINT "TrialSession_escrowedWei_nonnegative" CHECK ("escrowedWei" >= 0);

ALTER TABLE "Campaign"
  ADD CONSTRAINT "Campaign_sponsorAddress_lowercase" CHECK ("sponsorAddress" ~ '^0x[0-9a-f]{40}$'),
  ADD CONSTRAINT "Campaign_onchainId_bytes32" CHECK ("onchainId" ~ '^0x[0-9a-f]{64}$'),
  ADD CONSTRAINT "Campaign_amounts_nonnegative" CHECK (
    "rewardPerItemWei" >= 0 AND "reviewerFeeWei" >= 0 AND "qaFeeWei" >= 0 AND "fundedWei" >= 0
  ),
  ADD CONSTRAINT "Campaign_itemsTarget_positive" CHECK ("itemsTarget" > 0);

ALTER TABLE "TaskBatch"
  ADD CONSTRAINT "TaskBatch_onchainId_bytes32" CHECK ("onchainId" ~ '^0x[0-9a-f]{64}$'),
  ADD CONSTRAINT "TaskBatch_payout_within_max" CHECK (
    "maxPayoutWei" >= 0 AND ("payoutWei" IS NULL OR ("payoutWei" >= 0 AND "payoutWei" <= "maxPayoutWei"))
  );

ALTER TABLE "TaskSubmission"
  ADD CONSTRAINT "TaskSubmission_workerAddress_lowercase" CHECK ("workerAddress" ~ '^0x[0-9a-f]{40}$'),
  ADD CONSTRAINT "TaskSubmission_reviewerAddress_lowercase" CHECK (
    "reviewerAddress" IS NULL OR "reviewerAddress" ~ '^0x[0-9a-f]{40}$'
  ),
  ADD CONSTRAINT "TaskSubmission_reviewerScore_range" CHECK ("reviewerScore" IS NULL OR "reviewerScore" BETWEEN 1 AND 5),
  ADD CONSTRAINT "TaskSubmission_rewardWei_nonnegative" CHECK ("rewardWei" >= 0),
  ADD CONSTRAINT "TaskSubmission_activeItem_matches" CHECK ("activeItemId" IS NULL OR "activeItemId" = "itemId");

ALTER TABLE "QaVote"
  ADD CONSTRAINT "QaVote_qaAddress_lowercase" CHECK ("qaAddress" ~ '^0x[0-9a-f]{40}$');

ALTER TABLE "Epoch"
  ADD CONSTRAINT "Epoch_amounts_nonnegative" CHECK ("totalWei" >= 0 AND "bonusWei" >= 0 AND "feeWei" >= 0);

ALTER TABLE "EpochAllocation"
  ADD CONSTRAINT "EpochAllocation_walletAddress_lowercase" CHECK ("walletAddress" ~ '^0x[0-9a-f]{40}$'),
  ADD CONSTRAINT "EpochAllocation_amounts_valid" CHECK (
    "amountWei" > 0 AND "trialAmountWei" >= 0 AND "trialAmountWei" <= "amountWei"
  );

-- Wallet Week masks: 7 bits (Monday..Sunday).
ALTER TABLE "WalletWeekLog"
  ADD CONSTRAINT "WalletWeekLog_walletAddress_lowercase" CHECK ("walletAddress" ~ '^0x[0-9a-f]{40}$'),
  ADD CONSTRAINT "WalletWeekLog_masks_range" CHECK (
    "ubiClaimBitmask" BETWEEN 0 AND 127 AND "taskBitmask" BETWEEN 0 AND 127 AND "daysActiveBitmask" BETWEEN 0 AND 127
  );

ALTER TABLE "AgentRecord"
  ADD CONSTRAINT "AgentRecord_addresses_lowercase" CHECK (
    "agentAddress" ~ '^0x[0-9a-f]{40}$' AND "ownerAddress" ~ '^0x[0-9a-f]{40}$' AND "ownerRoot" ~ '^0x[0-9a-f]{40}$'
  ),
  ADD CONSTRAINT "AgentRecord_bondWei_nonnegative" CHECK ("bondWei" >= 0);

ALTER TABLE "OnchainEvent"
  ADD CONSTRAINT "OnchainEvent_addresses_lowercase" CHECK (
    "contractAddress" ~ '^0x[0-9a-f]{40}$'
    AND ("txFrom" IS NULL OR "txFrom" ~ '^0x[0-9a-f]{40}$')
    AND ("txTo" IS NULL OR "txTo" ~ '^0x[0-9a-f]{40}$')
  );

ALTER TABLE "RateLimitBucket"
  ADD CONSTRAINT "RateLimitBucket_count_nonnegative" CHECK ("count" >= 0);

-- Gas top-ups: slot 1..3 per root per UBI day; the open-request key is the root itself, only while REQUESTED.
ALTER TABLE "GasTopUp"
  ADD CONSTRAINT "GasTopUp_addresses_lowercase" CHECK (
    "walletAddress" ~ '^0x[0-9a-f]{40}$' AND "goodIdRoot" ~ '^0x[0-9a-f]{40}$'
  ),
  ADD CONSTRAINT "GasTopUp_dailySlot_range" CHECK ("dailySlot" BETWEEN 1 AND 3),
  ADD CONSTRAINT "GasTopUp_openRootKey_consistent" CHECK (
    ("status" = 'REQUESTED' AND "openRootKey" = "goodIdRoot") OR ("status" <> 'REQUESTED' AND "openRootKey" IS NULL)
  );

-- GoodID roots are the unique-human key: lowercase and never the zero address ("no root" is NULL).
ALTER TABLE "User"
  ADD CONSTRAINT "User_goodIdRoot_nonzero" CHECK ("goodIdRoot" <> '0x0000000000000000000000000000000000000000');
ALTER TABLE "TrialSession"
  ADD CONSTRAINT "TrialSession_walletAddress_lowercase" CHECK ("walletAddress" ~ '^0x[0-9a-f]{40}$'),
  ADD CONSTRAINT "TrialSession_convertedRoot_valid" CHECK (
    "convertedRoot" IS NULL
    OR ("convertedRoot" ~ '^0x[0-9a-f]{40}$' AND "convertedRoot" <> '0x0000000000000000000000000000000000000000')
  );
ALTER TABLE "TaskSubmission"
  ADD CONSTRAINT "TaskSubmission_roots_valid" CHECK (
    ("workerRoot" IS NULL
      OR ("workerRoot" ~ '^0x[0-9a-f]{40}$' AND "workerRoot" <> '0x0000000000000000000000000000000000000000'))
    AND ("reviewerRoot" IS NULL
      OR ("reviewerRoot" ~ '^0x[0-9a-f]{40}$' AND "reviewerRoot" <> '0x0000000000000000000000000000000000000000'))
  ),
  -- A submission holds its item (activeItemId) exactly while it is not rejected.
  ADD CONSTRAINT "TaskSubmission_live_iff_not_rejected" CHECK (("status" = 'REJECTED') = ("activeItemId" IS NULL));
ALTER TABLE "QaVote"
  ADD CONSTRAINT "QaVote_qaRoot_valid" CHECK (
    "qaRoot" IS NULL OR ("qaRoot" ~ '^0x[0-9a-f]{40}$' AND "qaRoot" <> '0x0000000000000000000000000000000000000000')
  ),
  ADD CONSTRAINT "QaVote_reject_has_reason" CHECK ("approve" OR "reason" IS NOT NULL);
ALTER TABLE "WalletWeekLog"
  ADD CONSTRAINT "WalletWeekLog_goodIdRoot_valid" CHECK (
    "goodIdRoot" IS NULL
    OR ("goodIdRoot" ~ '^0x[0-9a-f]{40}$' AND "goodIdRoot" <> '0x0000000000000000000000000000000000000000')
  );
ALTER TABLE "AgentRecord"
  ADD CONSTRAINT "AgentRecord_ownerRoot_nonzero" CHECK ("ownerRoot" <> '0x0000000000000000000000000000000000000000');
ALTER TABLE "GasTopUp"
  ADD CONSTRAINT "GasTopUp_goodIdRoot_nonzero" CHECK ("goodIdRoot" <> '0x0000000000000000000000000000000000000000');

-- Remaining address columns are lowercase too.
ALTER TABLE "TaskItem"
  ADD CONSTRAINT "TaskItem_aiAgentAddress_lowercase" CHECK ("aiAgentAddress" IS NULL OR "aiAgentAddress" ~ '^0x[0-9a-f]{40}$');
ALTER TABLE "TelegramLinkToken"
  ADD CONSTRAINT "TelegramLinkToken_walletAddress_lowercase" CHECK ("walletAddress" ~ '^0x[0-9a-f]{40}$'),
  ADD CONSTRAINT "TelegramLinkToken_tokenHash_sha256" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "NotificationLog"
  ADD CONSTRAINT "NotificationLog_walletAddress_lowercase" CHECK ("walletAddress" IS NULL OR "walletAddress" ~ '^0x[0-9a-f]{40}$');
ALTER TABLE "GuardianAction"
  ADD CONSTRAINT "GuardianAction_contractAddress_lowercase" CHECK ("contractAddress" ~ '^0x[0-9a-f]{40}$');
