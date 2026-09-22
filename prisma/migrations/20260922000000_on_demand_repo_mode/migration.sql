-- On-demand project repo creation mode: per-project repoMode config,
-- course-level staff team slug, and per-pool-row GitHub provisioning state.
CREATE TYPE "ProjectRepoMode" AS ENUM ('POOL', 'ON_DEMAND');

-- CreateTable
CREATE TABLE "ProjectRepoConfig" (
    "courseId" TEXT NOT NULL,
    "projectKey" TEXT NOT NULL,
    "repoMode" "ProjectRepoMode" NOT NULL DEFAULT 'POOL',
    "repoProjectName" TEXT,
    "githubOrg" TEXT,

    CONSTRAINT "ProjectRepoConfig_pkey" PRIMARY KEY ("courseId","projectKey")
);

-- AlterTable
ALTER TABLE "Course" ADD COLUMN "staffTeamSlug" TEXT;

-- AlterTable
ALTER TABLE "ProjectRepoPool" ADD COLUMN "provisionedAt" TIMESTAMP(3);

-- Backfill: every pool row that existed before on-demand support refers to a
-- repo that was created out-of-band, so it is provisioned by definition.
UPDATE "ProjectRepoPool" SET "provisionedAt" = NOW() WHERE "provisionedAt" IS NULL;

-- AddForeignKey
ALTER TABLE "ProjectRepoConfig" ADD CONSTRAINT "ProjectRepoConfig_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;
