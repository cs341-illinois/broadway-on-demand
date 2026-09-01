-- DropIndex
DROP INDEX "PartnerGroup_courseId_labSection_periodIndex_idx";

-- DropIndex
DROP INDEX "PartnerGroupMember_partnerGroupId_idx";

-- AlterTable
ALTER TABLE "Assignment" ADD COLUMN "partnerRoundNumber" INTEGER;

-- AlterTable
ALTER TABLE "PartnerGroup" ADD COLUMN "roundNumber" INTEGER;
UPDATE "PartnerGroup" SET "roundNumber" = "periodIndex" + 1;
ALTER TABLE "PartnerGroup" ALTER COLUMN "roundNumber" SET NOT NULL;
ALTER TABLE "PartnerGroup" DROP COLUMN "periodIndex";
ALTER TABLE "PartnerGroup" ADD COLUMN "archivedAt" TIMESTAMP(3);
ALTER TABLE "PartnerGroup" ADD COLUMN "archivedBy" TEXT;

-- AlterTable
ALTER TABLE "PartnerGroupMember" ADD COLUMN "id" TEXT;
UPDATE "PartnerGroupMember"
SET "id" = md5(random()::text || clock_timestamp()::text || "courseId" || "netId" || "periodIndex"::text)
WHERE "id" IS NULL;
ALTER TABLE "PartnerGroupMember" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "PartnerGroupMember" DROP CONSTRAINT "PartnerGroupMember_pkey";
ALTER TABLE "PartnerGroupMember" ADD COLUMN "roundNumber" INTEGER;
UPDATE "PartnerGroupMember" SET "roundNumber" = "periodIndex" + 1;
ALTER TABLE "PartnerGroupMember" ALTER COLUMN "roundNumber" SET NOT NULL;
ALTER TABLE "PartnerGroupMember" DROP COLUMN "periodIndex";
ALTER TABLE "PartnerGroupMember" ADD CONSTRAINT "PartnerGroupMember_pkey" PRIMARY KEY ("id");

-- CreateIndex
CREATE INDEX "PartnerGroup_courseId_labSection_roundNumber_archivedAt_idx" ON "PartnerGroup"("courseId", "labSection", "roundNumber", "archivedAt");

-- CreateIndex
CREATE INDEX "PartnerGroupMember_courseId_netId_roundNumber_idx" ON "PartnerGroupMember"("courseId", "netId", "roundNumber");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerGroupMember_partnerGroupId_netId_key" ON "PartnerGroupMember"("partnerGroupId", "netId");

-- Cancel any PARTNER_ROTATION jobs left PENDING from the previous scheduler-driven rotation.
UPDATE "Job" SET "status" = 'CANCELLED' WHERE "type" = 'PARTNER_ROTATION' AND "status" = 'PENDING';
