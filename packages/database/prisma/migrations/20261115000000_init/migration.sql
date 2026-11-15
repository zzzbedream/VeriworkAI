-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('WORKER', 'REVIEWER', 'QA', 'SPONSOR', 'ADMIN');

-- CreateEnum
CREATE TYPE "TaskType" AS ENUM ('RLHF', 'TRANSLATION_VALIDATION', 'LABELING');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'FUNDED', 'ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BatchStatus" AS ENUM ('DRAFT', 'AI_DRAFTED', 'IN_HUMAN_REVIEW', 'CONSENSUS_REACHED', 'SETTLED_ON_CHAIN', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SubmissionStatus" AS ENUM ('PENDING_REVIEW', 'PENDING_QA', 'ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "EpochStatus" AS ENUM ('DRAFT', 'POSTED', 'VETOED', 'SWEPT');

-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'UNBONDING', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "GasTopUpStatus" AS ENUM ('REQUESTED', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "PriceSource" AS ENUM ('MENTO_RESERVE', 'COINGECKO');

-- CreateEnum
CREATE TYPE "GuardianActionKind" AS ENUM ('PAUSE', 'VETO_EPOCH');

-- CreateEnum
CREATE TYPE "GuardianActionStatus" AS ENUM ('PENDING', 'SENT', 'CONFIRMED', 'SKIPPED', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "walletAddress" VARCHAR(42) NOT NULL,
    "goodIdRoot" VARCHAR(42),
    "goodIdVerified" BOOLEAN NOT NULL DEFAULT false,
    "goodIdLastCheckedAt" TIMESTAMPTZ(3),
    "goodIdExpiresAt" TIMESTAMPTZ(3),
    "goodIdFirstWindow" BOOLEAN NOT NULL DEFAULT false,
    "telegramChatId" BIGINT,
    "locale" VARCHAR(16) NOT NULL DEFAULT 'en',
    "languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "roles" "Role"[] DEFAULT ARRAY['WORKER']::"Role"[],
    "reputation" INTEGER NOT NULL DEFAULT 0,
    "invitedByAddress" VARCHAR(42),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("walletAddress")
);

-- CreateTable
CREATE TABLE "TrialSession" (
    "walletAddress" VARCHAR(42) NOT NULL,
    "tasksCompleted" INTEGER NOT NULL DEFAULT 0,
    "escrowedWei" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),
    "convertedToVerifiedAt" TIMESTAMPTZ(3),
    "convertedRoot" VARCHAR(42),

    CONSTRAINT "TrialSession_pkey" PRIMARY KEY ("walletAddress")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" UUID NOT NULL,
    "onchainId" VARCHAR(66) NOT NULL,
    "sponsorAddress" VARCHAR(42) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "description" TEXT NOT NULL,
    "taskType" "TaskType" NOT NULL,
    "instructions" TEXT NOT NULL,
    "languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requiredModuleId" INTEGER,
    "rewardPerItemWei" DECIMAL(78,0) NOT NULL,
    "reviewerFeeWei" DECIMAL(78,0) NOT NULL,
    "qaFeeWei" DECIMAL(78,0) NOT NULL,
    "itemsTarget" INTEGER NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "fundedWei" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "fundTxHash" VARCHAR(66),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskBatch" (
    "id" UUID NOT NULL,
    "onchainId" VARCHAR(66) NOT NULL,
    "campaignId" UUID NOT NULL,
    "status" "BatchStatus" NOT NULL DEFAULT 'DRAFT',
    "maxPayoutWei" DECIMAL(78,0) NOT NULL,
    "payoutWei" DECIMAL(78,0),
    "resultsHash" VARCHAR(66),
    "epochId" INTEGER,
    "openTxHash" VARCHAR(66),
    "reviewTxHash" VARCHAR(66),
    "consensusTxHash" VARCHAR(66),
    "settleTxHash" VARCHAR(66),
    "cancelTxHash" VARCHAR(66),
    "deadlineAt" TIMESTAMPTZ(3),
    "publishedAt" TIMESTAMPTZ(3),
    "consensusAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TaskBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskItem" (
    "id" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "input" JSONB NOT NULL,
    "aiAgentAddress" VARCHAR(42),
    "aiModel" VARCHAR(100),
    "aiInitialOutput" JSONB,
    "aiOutputHash" VARCHAR(66),
    "aiSignature" TEXT,
    "aiDraftedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskSubmission" (
    "id" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "workerAddress" VARCHAR(42) NOT NULL,
    "workerRoot" VARCHAR(42),
    "isTrial" BOOLEAN NOT NULL DEFAULT false,
    "humanCorrection" JSONB NOT NULL,
    "status" "SubmissionStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "activeItemId" UUID,
    "reviewerAddress" VARCHAR(42),
    "reviewerRoot" VARCHAR(42),
    "reviewerScore" INTEGER,
    "reviewerNotes" TEXT,
    "reviewedAt" TIMESTAMPTZ(3),
    "qaPassed" BOOLEAN,
    "finalizedAt" TIMESTAMPTZ(3),
    "rewardWei" DECIMAL(78,0) NOT NULL,
    "epochId" INTEGER,
    "claimTxHash" VARCHAR(66),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TaskSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QaVote" (
    "id" UUID NOT NULL,
    "submissionId" UUID NOT NULL,
    "qaAddress" VARCHAR(42) NOT NULL,
    "qaRoot" VARCHAR(42),
    "approve" BOOLEAN NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QaVote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Epoch" (
    "id" INTEGER NOT NULL,
    "merkleRoot" VARCHAR(66),
    "totalWei" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "bonusWei" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "feeWei" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "status" "EpochStatus" NOT NULL DEFAULT 'DRAFT',
    "settleTxHash" VARCHAR(66),
    "claimableAt" TIMESTAMPTZ(3),
    "expiresAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Epoch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EpochAllocation" (
    "epochId" INTEGER NOT NULL,
    "walletAddress" VARCHAR(42) NOT NULL,
    "amountWei" DECIMAL(78,0) NOT NULL,
    "trialAmountWei" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "proof" TEXT[],
    "breakdown" JSONB NOT NULL,
    "claimedTxHash" VARCHAR(66),
    "claimedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EpochAllocation_pkey" PRIMARY KEY ("epochId","walletAddress")
);

-- CreateTable
CREATE TABLE "WalletWeekLog" (
    "id" UUID NOT NULL,
    "walletAddress" VARCHAR(42) NOT NULL,
    "goodIdRoot" VARCHAR(42),
    "weekNumber" INTEGER NOT NULL,
    "mondayStakeTx" VARCHAR(66),
    "stakeAmountWei" DECIMAL(78,0),
    "ubiClaimBitmask" INTEGER NOT NULL DEFAULT 0,
    "taskBitmask" INTEGER NOT NULL DEFAULT 0,
    "daysActiveBitmask" INTEGER NOT NULL DEFAULT 0,
    "fridayBonusEligible" BOOLEAN NOT NULL DEFAULT false,
    "fridayBonusClaimed" BOOLEAN NOT NULL DEFAULT false,
    "slashedWei" DECIMAL(78,0),
    "sundaySettledTx" VARCHAR(66),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "WalletWeekLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRecord" (
    "agentAddress" VARCHAR(42) NOT NULL,
    "ownerAddress" VARCHAR(42) NOT NULL,
    "ownerRoot" VARCHAR(42) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "model" VARCHAR(100) NOT NULL,
    "status" "AgentStatus" NOT NULL DEFAULT 'ACTIVE',
    "bondWei" DECIMAL(78,0) NOT NULL,
    "metadataHash" VARCHAR(66),
    "registeredTxHash" VARCHAR(66),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AgentRecord_pkey" PRIMARY KEY ("agentAddress")
);

-- CreateTable
CREATE TABLE "TelegramLinkToken" (
    "tokenHash" VARCHAR(64) NOT NULL,
    "walletAddress" VARCHAR(42) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramLinkToken_pkey" PRIMARY KEY ("tokenHash")
);

-- CreateTable
CREATE TABLE "AuthNonce" (
    "nonce" VARCHAR(96) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthNonce_pkey" PRIMARY KEY ("nonce")
);

-- CreateTable
CREATE TABLE "OnchainEvent" (
    "id" BIGSERIAL NOT NULL,
    "chainId" INTEGER NOT NULL,
    "contractAddress" VARCHAR(42) NOT NULL,
    "eventName" VARCHAR(64) NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "blockTimestamp" TIMESTAMPTZ(3) NOT NULL,
    "txHash" VARCHAR(66) NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "txFrom" VARCHAR(42),
    "txTo" VARCHAR(42),
    "args" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OnchainEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IndexerCheckpoint" (
    "id" VARCHAR(100) NOT NULL,
    "lastBlock" BIGINT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "IndexerCheckpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateLimitBucket" (
    "key" VARCHAR(200) NOT NULL,
    "windowStart" TIMESTAMPTZ(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("key","windowStart")
);

-- CreateTable
CREATE TABLE "NotificationLog" (
    "id" UUID NOT NULL,
    "dedupeKey" VARCHAR(200) NOT NULL,
    "kind" VARCHAR(64) NOT NULL,
    "walletAddress" VARCHAR(42),
    "chatId" BIGINT,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMPTZ(3),

    CONSTRAINT "NotificationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertLog" (
    "id" UUID NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "source" VARCHAR(64) NOT NULL,
    "message" TEXT NOT NULL,
    "details" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMPTZ(3),

    CONSTRAINT "AlertLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceSample" (
    "id" BIGSERIAL NOT NULL,
    "source" "PriceSource" NOT NULL,
    "priceE18" DECIMAL(78,0) NOT NULL,
    "blockNumber" BIGINT,
    "sampledAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PriceSample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuardianAction" (
    "id" UUID NOT NULL,
    "kind" "GuardianActionKind" NOT NULL,
    "contractAddress" VARCHAR(42) NOT NULL,
    "epochId" INTEGER,
    "reason" TEXT NOT NULL,
    "status" "GuardianActionStatus" NOT NULL DEFAULT 'PENDING',
    "txHash" VARCHAR(66),
    "error" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "GuardianAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GasTopUp" (
    "id" UUID NOT NULL,
    "walletAddress" VARCHAR(42) NOT NULL,
    "goodIdRoot" VARCHAR(42) NOT NULL,
    "ubiDay" INTEGER NOT NULL,
    "dailySlot" INTEGER NOT NULL,
    "openRootKey" VARCHAR(42),
    "status" "GasTopUpStatus" NOT NULL DEFAULT 'REQUESTED',
    "balanceWei" DECIMAL(78,0) NOT NULL,
    "txHash" VARCHAR(66),
    "failureReason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMPTZ(3),
    "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMPTZ(3),

    CONSTRAINT "GasTopUp_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_telegramChatId_key" ON "User"("telegramChatId");

-- CreateIndex
CREATE INDEX "User_goodIdRoot_idx" ON "User"("goodIdRoot");

-- CreateIndex
CREATE INDEX "User_goodIdVerified_goodIdExpiresAt_idx" ON "User"("goodIdVerified", "goodIdExpiresAt");

-- CreateIndex
CREATE INDEX "User_invitedByAddress_idx" ON "User"("invitedByAddress");

-- CreateIndex
CREATE INDEX "TrialSession_startedAt_idx" ON "TrialSession"("startedAt");

-- CreateIndex
CREATE INDEX "TrialSession_convertedRoot_idx" ON "TrialSession"("convertedRoot");

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_onchainId_key" ON "Campaign"("onchainId");

-- CreateIndex
CREATE INDEX "Campaign_sponsorAddress_createdAt_idx" ON "Campaign"("sponsorAddress", "createdAt");

-- CreateIndex
CREATE INDEX "Campaign_status_createdAt_idx" ON "Campaign"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TaskBatch_onchainId_key" ON "TaskBatch"("onchainId");

-- CreateIndex
CREATE INDEX "TaskBatch_campaignId_status_idx" ON "TaskBatch"("campaignId", "status");

-- CreateIndex
CREATE INDEX "TaskBatch_status_createdAt_idx" ON "TaskBatch"("status", "createdAt");

-- CreateIndex
CREATE INDEX "TaskBatch_epochId_idx" ON "TaskBatch"("epochId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskItem_batchId_position_key" ON "TaskItem"("batchId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "TaskSubmission_activeItemId_key" ON "TaskSubmission"("activeItemId");

-- CreateIndex
CREATE INDEX "TaskSubmission_status_createdAt_idx" ON "TaskSubmission"("status", "createdAt");

-- CreateIndex
CREATE INDEX "TaskSubmission_status_reviewedAt_idx" ON "TaskSubmission"("status", "reviewedAt");

-- CreateIndex
CREATE INDEX "TaskSubmission_status_finalizedAt_idx" ON "TaskSubmission"("status", "finalizedAt");

-- CreateIndex
CREATE INDEX "TaskSubmission_batchId_status_idx" ON "TaskSubmission"("batchId", "status");

-- CreateIndex
CREATE INDEX "TaskSubmission_workerAddress_createdAt_idx" ON "TaskSubmission"("workerAddress", "createdAt");

-- CreateIndex
CREATE INDEX "TaskSubmission_workerRoot_status_idx" ON "TaskSubmission"("workerRoot", "status");

-- CreateIndex
CREATE INDEX "TaskSubmission_reviewerRoot_status_idx" ON "TaskSubmission"("reviewerRoot", "status");

-- CreateIndex
CREATE INDEX "TaskSubmission_epochId_idx" ON "TaskSubmission"("epochId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskSubmission_itemId_workerAddress_key" ON "TaskSubmission"("itemId", "workerAddress");

-- CreateIndex
CREATE INDEX "QaVote_qaAddress_createdAt_idx" ON "QaVote"("qaAddress", "createdAt");

-- CreateIndex
CREATE INDEX "QaVote_qaRoot_idx" ON "QaVote"("qaRoot");

-- CreateIndex
CREATE UNIQUE INDEX "QaVote_submissionId_qaAddress_key" ON "QaVote"("submissionId", "qaAddress");

-- CreateIndex
CREATE UNIQUE INDEX "QaVote_submissionId_qaRoot_key" ON "QaVote"("submissionId", "qaRoot");

-- CreateIndex
CREATE INDEX "Epoch_status_idx" ON "Epoch"("status");

-- CreateIndex
CREATE INDEX "EpochAllocation_walletAddress_epochId_idx" ON "EpochAllocation"("walletAddress", "epochId");

-- CreateIndex
CREATE INDEX "WalletWeekLog_weekNumber_idx" ON "WalletWeekLog"("weekNumber");

-- CreateIndex
CREATE INDEX "WalletWeekLog_goodIdRoot_weekNumber_idx" ON "WalletWeekLog"("goodIdRoot", "weekNumber");

-- CreateIndex
CREATE UNIQUE INDEX "WalletWeekLog_walletAddress_weekNumber_key" ON "WalletWeekLog"("walletAddress", "weekNumber");

-- CreateIndex
CREATE INDEX "AgentRecord_ownerRoot_idx" ON "AgentRecord"("ownerRoot");

-- CreateIndex
CREATE INDEX "AgentRecord_ownerAddress_idx" ON "AgentRecord"("ownerAddress");

-- CreateIndex
CREATE INDEX "AgentRecord_status_idx" ON "AgentRecord"("status");

-- CreateIndex
CREATE INDEX "TelegramLinkToken_walletAddress_idx" ON "TelegramLinkToken"("walletAddress");

-- CreateIndex
CREATE INDEX "TelegramLinkToken_expiresAt_idx" ON "TelegramLinkToken"("expiresAt");

-- CreateIndex
CREATE INDEX "AuthNonce_expiresAt_idx" ON "AuthNonce"("expiresAt");

-- CreateIndex
CREATE INDEX "OnchainEvent_chainId_eventName_blockTimestamp_idx" ON "OnchainEvent"("chainId", "eventName", "blockTimestamp");

-- CreateIndex
CREATE INDEX "OnchainEvent_chainId_contractAddress_blockNumber_idx" ON "OnchainEvent"("chainId", "contractAddress", "blockNumber");

-- CreateIndex
CREATE INDEX "OnchainEvent_chainId_txTo_blockTimestamp_idx" ON "OnchainEvent"("chainId", "txTo", "blockTimestamp");

-- CreateIndex
CREATE INDEX "OnchainEvent_txFrom_blockTimestamp_idx" ON "OnchainEvent"("txFrom", "blockTimestamp");

-- CreateIndex
CREATE INDEX "OnchainEvent_blockTimestamp_idx" ON "OnchainEvent"("blockTimestamp");

-- CreateIndex
CREATE UNIQUE INDEX "OnchainEvent_chainId_txHash_logIndex_key" ON "OnchainEvent"("chainId", "txHash", "logIndex");

-- CreateIndex
CREATE INDEX "RateLimitBucket_windowStart_idx" ON "RateLimitBucket"("windowStart");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationLog_dedupeKey_key" ON "NotificationLog"("dedupeKey");

-- CreateIndex
CREATE INDEX "NotificationLog_kind_createdAt_idx" ON "NotificationLog"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "NotificationLog_walletAddress_createdAt_idx" ON "NotificationLog"("walletAddress", "createdAt");

-- CreateIndex
CREATE INDEX "AlertLog_createdAt_idx" ON "AlertLog"("createdAt");

-- CreateIndex
CREATE INDEX "AlertLog_source_createdAt_idx" ON "AlertLog"("source", "createdAt");

-- CreateIndex
CREATE INDEX "AlertLog_severity_createdAt_idx" ON "AlertLog"("severity", "createdAt");

-- CreateIndex
CREATE INDEX "PriceSample_source_sampledAt_idx" ON "PriceSample"("source", "sampledAt");

-- CreateIndex
CREATE INDEX "GuardianAction_kind_contractAddress_createdAt_idx" ON "GuardianAction"("kind", "contractAddress", "createdAt");

-- CreateIndex
CREATE INDEX "GuardianAction_createdAt_idx" ON "GuardianAction"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "GasTopUp_openRootKey_key" ON "GasTopUp"("openRootKey");

-- CreateIndex
CREATE INDEX "GasTopUp_status_requestedAt_idx" ON "GasTopUp"("status", "requestedAt");

-- CreateIndex
CREATE INDEX "GasTopUp_walletAddress_requestedAt_idx" ON "GasTopUp"("walletAddress", "requestedAt");

-- CreateIndex
CREATE UNIQUE INDEX "GasTopUp_goodIdRoot_ubiDay_dailySlot_key" ON "GasTopUp"("goodIdRoot", "ubiDay", "dailySlot");

-- AddForeignKey
ALTER TABLE "TrialSession" ADD CONSTRAINT "TrialSession_walletAddress_fkey" FOREIGN KEY ("walletAddress") REFERENCES "User"("walletAddress") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskBatch" ADD CONSTRAINT "TaskBatch_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskItem" ADD CONSTRAINT "TaskItem_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "TaskBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskSubmission" ADD CONSTRAINT "TaskSubmission_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "TaskItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskSubmission" ADD CONSTRAINT "TaskSubmission_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "TaskBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskSubmission" ADD CONSTRAINT "TaskSubmission_workerAddress_fkey" FOREIGN KEY ("workerAddress") REFERENCES "User"("walletAddress") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QaVote" ADD CONSTRAINT "QaVote_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "TaskSubmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EpochAllocation" ADD CONSTRAINT "EpochAllocation_epochId_fkey" FOREIGN KEY ("epochId") REFERENCES "Epoch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramLinkToken" ADD CONSTRAINT "TelegramLinkToken_walletAddress_fkey" FOREIGN KEY ("walletAddress") REFERENCES "User"("walletAddress") ON DELETE CASCADE ON UPDATE CASCADE;

