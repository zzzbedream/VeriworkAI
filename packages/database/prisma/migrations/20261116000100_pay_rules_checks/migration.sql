-- Pay rules, part 2: submissions written under the previous rules are converted to these rules, the
-- attempt column is completed, and the CHECK constraints are added NOT VALID and then validated (the
-- VALIDATE step proves every existing row satisfies them). The repositories enforce every rule
-- atomically; the constraints make a buggy caller fail loudly (defense in depth, like the
-- check-constraints migration). Safe on an empty database and on one that already holds rows.
--
-- How existing submissions (written by the previous pipeline) are converted:
--   * ACCEPTED, open (PENDING_REVIEW / PENDING_QA) and QA-rejected submissions (a full QA quorum
--     whose majority rejected) keep their status: they mean the same under these rules.
--   * Every other REJECTED submission had no QA consensus and becomes VOIDED (no verdict, pays
--     nobody): open work closed when its batch froze or was cancelled (BATCH_FROZEN /
--     BATCH_CANCELLED), trial work closed because its own human had decided it
--     (CONFLICT_OF_INTEREST), and rejections by the reviewer alone (LEGACY_RULES).
--   * At most 2 attempts per item and trial work on attempt 1 only: an item keeps its live submission
--     (accepted or open) and as many of its latest QA rejections as still fit; older ones become
--     VOIDED (LEGACY_RULES). Kept submissions are numbered from 1 in time order, VOIDED ones after
--     them. VOIDED rows that would break a rule these rules added (an attempt above 2, trial work on a
--     later attempt, a rejecting review without a reason) are marked LEGACY_RULES: the only rows the
--     constraints exempt, and a reason the pipeline itself never writes.
--   * DRAFT batches never sent on-chain get the current worst-case reservation. Batches already
--     opened on-chain keep theirs: the freeze refuses a payout above it and never overwrites a payout
--     frozen earlier.

-- The rule this migration replaces (a submission holds its item unless REJECTED) knows no VOIDED.
ALTER TABLE "TaskSubmission" DROP CONSTRAINT "TaskSubmission_live_iff_not_rejected";

-- 1. Rejections without a QA consensus are not verdicts under these rules: they become VOIDED.
UPDATE "TaskSubmission" s
SET "status" = 'VOIDED',
    "voidReason" = (CASE
      WHEN s."qaPassed" IS FALSE THEN 'CONFLICT_OF_INTEREST'
      WHEN s."qaPassed" IS TRUE THEN 'LEGACY_RULES'
      WHEN s."reviewerScore" < 3 THEN 'LEGACY_RULES'
      WHEN b."status" = 'CANCELLED' THEN 'BATCH_CANCELLED'
      ELSE 'BATCH_FROZEN'
    END)::"SubmissionVoidReason",
    "qaPassed" = NULL,
    "activeItemId" = NULL,
    "finalizedAt" = coalesce(s."finalizedAt", s."updatedAt")
FROM "TaskBatch" b
JOIN "Campaign" c ON c."id" = b."campaignId"
WHERE b."id" = s."batchId"
  AND s."status" = 'REJECTED'
  AND NOT (
    s."qaPassed" IS FALSE
    AND coalesce(s."reviewerScore", 0) >= 3
    AND (SELECT count(*) FROM "QaVote" v WHERE v."submissionId" = s."id") = c."qaQuorum"
    AND (SELECT count(*) FROM "QaVote" v WHERE v."submissionId" = s."id" AND v."approve")
      < c."qaApprovalsRequired"
  );

-- Verdict fields follow the status (no-ops on rows the previous pipeline wrote): accepted work has
-- qaPassed = true and a close time, open work has neither.
UPDATE "TaskSubmission"
SET "qaPassed" = true, "finalizedAt" = coalesce("finalizedAt", "updatedAt")
WHERE "status" = 'ACCEPTED' AND ("qaPassed" IS DISTINCT FROM true OR "finalizedAt" IS NULL);
UPDATE "TaskSubmission"
SET "qaPassed" = NULL, "finalizedAt" = NULL
WHERE "status" IN ('PENDING_REVIEW', 'PENDING_QA')
  AND ("qaPassed" IS NOT NULL OR "finalizedAt" IS NOT NULL);

-- 2. Attempts: an item keeps its live submission and its latest QA rejections while they fit in
--    2 attempts with trial work first; the older rejections become VOIDED (LEGACY_RULES).
WITH "live" AS (
  SELECT "itemId", bool_or("isTrial") AS "isTrial"
  FROM "TaskSubmission"
  WHERE "status" IN ('ACCEPTED', 'PENDING_REVIEW', 'PENDING_QA')
  GROUP BY "itemId"
), "rejected" AS (
  SELECT "id", "itemId",
    row_number() OVER "newest" AS "recency",
    first_value("isTrial") OVER "newest" AS "newestIsTrial"
  FROM "TaskSubmission"
  WHERE "status" = 'REJECTED'
  WINDOW "newest" AS (PARTITION BY "itemId" ORDER BY "createdAt" DESC, "id" DESC)
)
UPDATE "TaskSubmission" s
SET "status" = 'VOIDED', "voidReason" = 'LEGACY_RULES', "qaPassed" = NULL
FROM "rejected" r
LEFT JOIN "live" l ON l."itemId" = r."itemId"
WHERE s."id" = r."id"
  AND r."recency" > (CASE
    WHEN l."itemId" IS NOT NULL AND l."isTrial" THEN 0
    WHEN l."itemId" IS NOT NULL THEN 1
    WHEN r."newestIsTrial" THEN 1
    ELSE 2
  END);

-- 3. Number the attempts: kept submissions first, in time order, then the VOIDED ones.
UPDATE "TaskSubmission" s
SET "attempt" = n."attempt"
FROM (
  SELECT "id", row_number() OVER (
    PARTITION BY "itemId" ORDER BY ("status" = 'VOIDED'), "createdAt", "id"
  ) AS "attempt"
  FROM "TaskSubmission"
) n
WHERE s."id" = n."id";

-- 4. VOIDED rows that would break a rule only these rules impose are marked LEGACY_RULES.
UPDATE "TaskSubmission"
SET "voidReason" = 'LEGACY_RULES'
WHERE "status" = 'VOIDED' AND "voidReason" <> 'LEGACY_RULES'
  AND ("attempt" > 2 OR ("isTrial" AND "attempt" >= 2)
    OR ("reviewerScore" < 3 AND btrim(coalesce("reviewerNotes", '')) = ''));

ALTER TABLE "TaskSubmission" ALTER COLUMN "attempt" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "TaskSubmission_itemId_attempt_key" ON "TaskSubmission"("itemId", "attempt");

-- 5. DRAFT batches never sent on-chain reserve the current worst case per item:
--    reward + MAX_ATTEMPTS_PER_ITEM (2) x (reviewer fee + quorum x QA fee).
UPDATE "TaskBatch" b
SET "maxPayoutWei" = n."items"
  * (c."rewardPerItemWei" + 2 * (c."reviewerFeeWei" + c."qaQuorum" * c."qaFeeWei"))
FROM "Campaign" c, (SELECT "batchId", count(*) AS "items" FROM "TaskItem" GROUP BY "batchId") n
WHERE b."status" = 'DRAFT' AND b."openTxHash" IS NULL
  AND c."id" = b."campaignId" AND n."batchId" = b."id";

-- 6. Constraints, NOT VALID first, then validated against every existing row.

-- QA profile: Standard (3 votes, 2 approvals) or Pilot (1 vote, 1 approval).
ALTER TABLE "Campaign"
  ADD CONSTRAINT "Campaign_qaProfile_valid" CHECK (
    ("qaQuorum" = 3 AND "qaApprovalsRequired" = 2) OR ("qaQuorum" = 1 AND "qaApprovalsRequired" = 1)
  ) NOT VALID;

ALTER TABLE "TaskSubmission"
  -- At most MAX_ATTEMPTS_PER_ITEM (2) submissions per item: attempt 1..2, unique per item.
  ADD CONSTRAINT "TaskSubmission_attempt_range" CHECK (
    "attempt" >= 1 AND ("attempt" <= 2 OR "voidReason" IS NOT DISTINCT FROM 'LEGACY_RULES')
  ) NOT VALID,
  -- Trial (unverified) work never takes the last attempt: only a verified human can close an item.
  ADD CONSTRAINT "TaskSubmission_trial_not_last_attempt" CHECK (
    NOT "isTrial" OR "attempt" < 2 OR "voidReason" IS NOT DISTINCT FROM 'LEGACY_RULES'
  ) NOT VALID,
  -- A review is stored whole, with its verdict (accept iff score >= 3).
  ADD CONSTRAINT "TaskSubmission_review_complete" CHECK (
    ("reviewerScore" IS NULL) = ("reviewerApprove" IS NULL)
    AND ("reviewerScore" IS NULL) = ("reviewerAddress" IS NULL)
    AND ("reviewerScore" IS NULL) = ("reviewerRoot" IS NULL)
    AND ("reviewerScore" IS NULL) = ("reviewedAt" IS NULL)
    AND ("reviewerApprove" IS NULL OR "reviewerApprove" = ("reviewerScore" >= 3))
  ) NOT VALID,
  -- A rejecting review (score below 3) says why.
  ADD CONSTRAINT "TaskSubmission_rejecting_review_has_reason" CHECK (
    "reviewerScore" IS NULL OR "reviewerScore" >= 3 OR btrim(coalesce("reviewerNotes", '')) <> ''
    OR "voidReason" IS NOT DISTINCT FROM 'LEGACY_RULES'
  ) NOT VALID,
  -- Only reviewed submissions reach QA or a verdict.
  ADD CONSTRAINT "TaskSubmission_reviewed_before_qa" CHECK (
    "status" NOT IN ('PENDING_QA', 'ACCEPTED', 'REJECTED') OR "reviewerApprove" IS NOT NULL
  ) NOT VALID,
  -- qaPassed is the QA verdict: true for ACCEPTED, false for REJECTED, unset otherwise (open, VOIDED).
  ADD CONSTRAINT "TaskSubmission_qaPassed_matches_status" CHECK (
    "qaPassed" IS NOT DISTINCT FROM (CASE "status" WHEN 'ACCEPTED' THEN true WHEN 'REJECTED' THEN false END)
  ) NOT VALID,
  -- VOIDED (no verdict, pays nobody) always records why; nothing else has a void reason.
  ADD CONSTRAINT "TaskSubmission_voidReason_iff_voided" CHECK (
    ("status" = 'VOIDED') = ("voidReason" IS NOT NULL)
  ) NOT VALID,
  -- Accepted, rejected and voided submissions have a close time; open ones do not.
  ADD CONSTRAINT "TaskSubmission_finalizedAt_iff_closed" CHECK (
    ("status" IN ('ACCEPTED', 'REJECTED', 'VOIDED')) = ("finalizedAt" IS NOT NULL)
  ) NOT VALID,
  -- A submission holds its item (activeItemId) while it is open or accepted.
  ADD CONSTRAINT "TaskSubmission_live_iff_open_or_accepted" CHECK (
    ("status" IN ('REJECTED', 'VOIDED')) = ("activeItemId" IS NULL)
  ) NOT VALID;

ALTER TABLE "Campaign" VALIDATE CONSTRAINT "Campaign_qaProfile_valid";
ALTER TABLE "TaskSubmission" VALIDATE CONSTRAINT "TaskSubmission_attempt_range";
ALTER TABLE "TaskSubmission" VALIDATE CONSTRAINT "TaskSubmission_trial_not_last_attempt";
ALTER TABLE "TaskSubmission" VALIDATE CONSTRAINT "TaskSubmission_review_complete";
ALTER TABLE "TaskSubmission" VALIDATE CONSTRAINT "TaskSubmission_rejecting_review_has_reason";
ALTER TABLE "TaskSubmission" VALIDATE CONSTRAINT "TaskSubmission_reviewed_before_qa";
ALTER TABLE "TaskSubmission" VALIDATE CONSTRAINT "TaskSubmission_qaPassed_matches_status";
ALTER TABLE "TaskSubmission" VALIDATE CONSTRAINT "TaskSubmission_voidReason_iff_voided";
ALTER TABLE "TaskSubmission" VALIDATE CONSTRAINT "TaskSubmission_finalizedAt_iff_closed";
ALTER TABLE "TaskSubmission" VALIDATE CONSTRAINT "TaskSubmission_live_iff_open_or_accepted";
