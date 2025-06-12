-- CreateEnum
CREATE TYPE "Role" AS ENUM ('STUDENT', 'STAFF', 'ADMIN');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'INFRA_ERROR', 'TIMEOUT');

-- CreateEnum
CREATE TYPE "JobType" AS ENUM ('STUDENT_INITIATED', 'FINAL_GRADING', 'REGRADE');

-- CreateEnum
CREATE TYPE "AssignmentVisibility" AS ENUM ('DEFAULT', 'FORCE_OPEN', 'FORCE_CLOSE', 'INVISIBLE_FORCE_CLOSE');

-- CreateEnum
CREATE TYPE "AssignmentQuota" AS ENUM ('DAILY', 'TOTAL');

-- CreateEnum
CREATE TYPE "Category" AS ENUM ('LAB', 'MP', 'ATTENDANCE', 'BONUS', 'FINAL', 'OTHER');

-- CreateEnum
CREATE TYPE "AutogradableCategory" AS ENUM ('LAB', 'MP');

-- CreateEnum
CREATE TYPE "ExtensionInitiator" AS ENUM ('STUDENT', 'STAFF');

-- CreateTable
CREATE TABLE "Course" (
    "id" TEXT NOT NULL,
    "githubOrg" TEXT NOT NULL,
    "githubRepoPrefix" TEXT NOT NULL,
    "githubToken" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "jenkinsToken" TEXT NOT NULL,
    "feedbackBranchName" TEXT NOT NULL,
    "courseCutoff" TIMESTAMP(3) NOT NULL,
    "jenkinsBaseUrl" TEXT NOT NULL,
    "courseTimezone" TEXT NOT NULL,
    "gradesRepo" TEXT NOT NULL,
    "firstLabDate" TIMESTAMP(3) NOT NULL,
    "numExtensions" INTEGER NOT NULL,
    "numExtensionHours" INTEGER NOT NULL,

    CONSTRAINT "Course_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Users" (
    "netId" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "courseId" TEXT NOT NULL,
    "uin" TEXT,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Users_pkey" PRIMARY KEY ("netId","courseId")
);

-- CreateTable
CREATE TABLE "Assignment" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "visibility" "AssignmentVisibility" NOT NULL,
    "quotaPeriod" "AssignmentQuota" NOT NULL,
    "category" "Category" NOT NULL,
    "studentExtendable" BOOLEAN NOT NULL,
    "jenkinsPipelineName" TEXT,
    "quotaAmount" INTEGER NOT NULL,
    "finalGradingRunId" TEXT,
    "openAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Assignment_pkey" PRIMARY KEY ("courseId","id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "netId" TEXT[],
    "type" "JobType" NOT NULL,
    "autogradableCategory" "AutogradableCategory",
    "buildUrl" TEXT,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "scheduledAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "failedAt" TIMESTAMP(3),
    "usersNetId" TEXT,
    "usersCourseId" TEXT,
    "assignmentCourseId" TEXT,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublishedGrades" (
    "courseId" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "netId" TEXT NOT NULL,
    "comments" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "PublishedGrades_pkey" PRIMARY KEY ("courseId","assignmentId","netId")
);

-- CreateTable
CREATE TABLE "StagingGrades" (
    "jobId" TEXT NOT NULL,
    "netId" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "comments" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "courseId" TEXT NOT NULL,
    "usersNetId" TEXT,
    "usersCourseId" TEXT,

    CONSTRAINT "StagingGrades_pkey" PRIMARY KEY ("jobId","netId")
);

-- CreateTable
CREATE TABLE "Extensions" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "netId" TEXT NOT NULL,
    "quotaAmount" INTEGER NOT NULL,
    "finalGradingRunId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "extensionType" "ExtensionInitiator" NOT NULL,
    "quotaPeriod" "AssignmentQuota" NOT NULL,
    "openAt" TIMESTAMP(3) NOT NULL,
    "closeAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Extensions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtensionUsageHistory" (
    "extensionId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "netId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExtensionUsageHistory_pkey" PRIMARY KEY ("extensionId","courseId","assignmentId","netId","createdAt")
);

-- CreateTable
CREATE TABLE "AttendanceRecord" (
    "courseId" TEXT NOT NULL,
    "weekId" INTEGER NOT NULL,
    "netId" TEXT NOT NULL,
    "submitted" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "assignmentCourseId" TEXT,
    "assignmentId" TEXT,

    CONSTRAINT "AttendanceRecord_pkey" PRIMARY KEY ("courseId","weekId","netId")
);

-- CreateIndex
CREATE INDEX "Users_netId_idx" ON "Users"("netId");

-- CreateIndex
CREATE INDEX "Users_courseId_netId_idx" ON "Users"("courseId", "netId");

-- CreateIndex
CREATE INDEX "Users_courseId_uin_idx" ON "Users"("courseId", "uin");

-- CreateIndex
CREATE UNIQUE INDEX "Users_courseId_uin_key" ON "Users"("courseId", "uin");

-- CreateIndex
CREATE INDEX "Assignment_courseId_visibility_idx" ON "Assignment"("courseId", "visibility");

-- CreateIndex
CREATE INDEX "Job_status_scheduledAt_idx" ON "Job"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "Job_name_status_idx" ON "Job"("name", "status");

-- CreateIndex
CREATE INDEX "Job_courseId_assignmentId_type_idx" ON "Job"("courseId", "assignmentId", "type");

-- CreateIndex
CREATE INDEX "PublishedGrades_courseId_assignmentId_idx" ON "PublishedGrades"("courseId", "assignmentId");

-- CreateIndex
CREATE INDEX "PublishedGrades_courseId_netId_idx" ON "PublishedGrades"("courseId", "netId");

-- CreateIndex
CREATE INDEX "StagingGrades_jobId_idx" ON "StagingGrades"("jobId");

-- CreateIndex
CREATE INDEX "Extensions_courseId_assignmentId_netId_idx" ON "Extensions"("courseId", "assignmentId", "netId");

-- AddForeignKey
ALTER TABLE "Users" ADD CONSTRAINT "Users_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_usersNetId_usersCourseId_fkey" FOREIGN KEY ("usersNetId", "usersCourseId") REFERENCES "Users"("netId", "courseId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_assignmentCourseId_assignmentId_fkey" FOREIGN KEY ("assignmentCourseId", "assignmentId") REFERENCES "Assignment"("courseId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishedGrades" ADD CONSTRAINT "PublishedGrades_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishedGrades" ADD CONSTRAINT "PublishedGrades_netId_courseId_fkey" FOREIGN KEY ("netId", "courseId") REFERENCES "Users"("netId", "courseId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishedGrades" ADD CONSTRAINT "PublishedGrades_courseId_assignmentId_fkey" FOREIGN KEY ("courseId", "assignmentId") REFERENCES "Assignment"("courseId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StagingGrades" ADD CONSTRAINT "StagingGrades_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StagingGrades" ADD CONSTRAINT "StagingGrades_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StagingGrades" ADD CONSTRAINT "StagingGrades_usersNetId_usersCourseId_fkey" FOREIGN KEY ("usersNetId", "usersCourseId") REFERENCES "Users"("netId", "courseId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Extensions" ADD CONSTRAINT "Extensions_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Extensions" ADD CONSTRAINT "Extensions_netId_courseId_fkey" FOREIGN KEY ("netId", "courseId") REFERENCES "Users"("netId", "courseId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Extensions" ADD CONSTRAINT "Extensions_assignmentId_courseId_fkey" FOREIGN KEY ("assignmentId", "courseId") REFERENCES "Assignment"("id", "courseId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Extensions" ADD CONSTRAINT "Extensions_finalGradingRunId_fkey" FOREIGN KEY ("finalGradingRunId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtensionUsageHistory" ADD CONSTRAINT "ExtensionUsageHistory_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtensionUsageHistory" ADD CONSTRAINT "ExtensionUsageHistory_netId_courseId_fkey" FOREIGN KEY ("netId", "courseId") REFERENCES "Users"("netId", "courseId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtensionUsageHistory" ADD CONSTRAINT "ExtensionUsageHistory_assignmentId_courseId_fkey" FOREIGN KEY ("assignmentId", "courseId") REFERENCES "Assignment"("courseId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtensionUsageHistory" ADD CONSTRAINT "ExtensionUsageHistory_extensionId_fkey" FOREIGN KEY ("extensionId") REFERENCES "Extensions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_netId_courseId_fkey" FOREIGN KEY ("netId", "courseId") REFERENCES "Users"("netId", "courseId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_assignmentCourseId_assignmentId_fkey" FOREIGN KEY ("assignmentCourseId", "assignmentId") REFERENCES "Assignment"("courseId", "id") ON DELETE SET NULL ON UPDATE CASCADE;
