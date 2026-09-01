-- AlterEnum
ALTER TYPE "JobType" ADD VALUE 'PARTNER_ROTATION';

-- AlterTable
ALTER TABLE "Users" ADD COLUMN     "labSection" TEXT;

-- CreateTable
CREATE TABLE "PartnerGroup" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "labSection" TEXT NOT NULL,
    "periodIndex" INTEGER NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerGroupMember" (
    "courseId" TEXT NOT NULL,
    "netId" TEXT NOT NULL,
    "periodIndex" INTEGER NOT NULL,
    "partnerGroupId" TEXT NOT NULL,

    CONSTRAINT "PartnerGroupMember_pkey" PRIMARY KEY ("courseId","netId","periodIndex")
);

-- CreateIndex
CREATE INDEX "PartnerGroup_courseId_labSection_periodIndex_idx" ON "PartnerGroup"("courseId", "labSection", "periodIndex");

-- CreateIndex
CREATE INDEX "PartnerGroupMember_partnerGroupId_idx" ON "PartnerGroupMember"("partnerGroupId");

-- AddForeignKey
ALTER TABLE "PartnerGroup" ADD CONSTRAINT "PartnerGroup_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerGroupMember" ADD CONSTRAINT "PartnerGroupMember_partnerGroupId_fkey" FOREIGN KEY ("partnerGroupId") REFERENCES "PartnerGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerGroupMember" ADD CONSTRAINT "PartnerGroupMember_netId_courseId_fkey" FOREIGN KEY ("netId", "courseId") REFERENCES "Users"("netId", "courseId") ON DELETE RESTRICT ON UPDATE CASCADE;

