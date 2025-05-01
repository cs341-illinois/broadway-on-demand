-- CreateEnum
CREATE TYPE "Role" AS ENUM ('STUDENT', 'STAFF', 'ADMIN');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'RECOVERY');

-- CreateEnum
CREATE TYPE "JobType" AS ENUM ('STUDENT_INITIATED', 'FINAL_GRADING', 'REGRADE');

-- CreateEnum
CREATE TYPE "AssignmentVisibility" AS ENUM ('DEFAULT', 'FORCE_OPEN', 'FORCE_CLOSE', 'INVISIBLE_FORCE_CLOSE');

-- CreateEnum
CREATE TYPE "AssignmentQuota" AS ENUM ('DAILY', 'TOTAL');

-- CreateEnum
CREATE TYPE "Category" AS ENUM ('LAB', 'MP', 'ATTENDANCE', 'OTHER');

-- CreateEnum
CREATE TYPE "RegisteredGradingJobsStatus" AS ENUM ('STARTED', 'FINISHED');

-- CreateTable
CREATE TABLE "Course" (
    "id" TEXT NOT NULL,
    "githubOrg" TEXT NOT NULL,
    "githubRepoPrefix" TEXT NOT NULL,
    "githubToken" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "queryToken" TEXT NOT NULL,
    "feedbackBranchName" TEXT NOT NULL,
    "courseCutoff" BIGINT NOT NULL,
    "jenkinsBaseUrl" TEXT NOT NULL,
    "numExtensions" INTEGER NOT NULL,
    "numExtensionHours" INTEGER NOT NULL,

    CONSTRAINT "Course_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Users" (
    "netId" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "courseId" TEXT NOT NULL,
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
    "type" "JobType" NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "scheduledAt" TIMESTAMP(3),
    "runAt" TIMESTAMP(3),
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobUser" (
    "jobId" TEXT NOT NULL,
    "netId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobUser_pkey" PRIMARY KEY ("jobId","netId","courseId")
);

-- CreateTable
CREATE TABLE "RegisteredGradingJobs" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "usersNetId" TEXT,
    "usersCourseId" TEXT,

    CONSTRAINT "RegisteredGradingJobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublishedGrades" (
    "courseId" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "netId" TEXT NOT NULL,
    "comments" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "assignmentCourseId" TEXT NOT NULL,

    CONSTRAINT "PublishedGrades_pkey" PRIMARY KEY ("courseId","assignmentId","netId")
);

-- CreateTable
CREATE TABLE "StagingGrades" (
    "jobId" TEXT NOT NULL,
    "netId" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "courseId" TEXT,
    "usersNetId" TEXT,
    "usersCourseId" TEXT,

    CONSTRAINT "StagingGrades_pkey" PRIMARY KEY ("jobId","netId")
);

-- CreateIndex
CREATE INDEX "Users_netId_idx" ON "Users"("netId");

-- CreateIndex
CREATE INDEX "Assignment_courseId_visibility_idx" ON "Assignment"("courseId", "visibility");

-- CreateIndex
CREATE INDEX "Job_status_scheduledAt_idx" ON "Job"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "Job_name_status_idx" ON "Job"("name", "status");

-- CreateIndex
CREATE INDEX "Job_courseId_assignmentId_type_idx" ON "Job"("courseId", "assignmentId", "type");

-- CreateIndex
CREATE INDEX "JobUser_jobId_idx" ON "JobUser"("jobId");

-- CreateIndex
CREATE INDEX "PublishedGrades_courseId_assignmentId_idx" ON "PublishedGrades"("courseId", "assignmentId");

-- CreateIndex
CREATE INDEX "PublishedGrades_netId_idx" ON "PublishedGrades"("netId");

-- CreateIndex
CREATE INDEX "StagingGrades_jobId_idx" ON "StagingGrades"("jobId");

-- AddForeignKey
ALTER TABLE "Users" ADD CONSTRAINT "Users_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_courseId_assignmentId_fkey" FOREIGN KEY ("courseId", "assignmentId") REFERENCES "Assignment"("courseId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobUser" ADD CONSTRAINT "JobUser_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobUser" ADD CONSTRAINT "JobUser_netId_courseId_fkey" FOREIGN KEY ("netId", "courseId") REFERENCES "Users"("netId", "courseId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegisteredGradingJobs" ADD CONSTRAINT "RegisteredGradingJobs_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegisteredGradingJobs" ADD CONSTRAINT "RegisteredGradingJobs_courseId_assignmentId_fkey" FOREIGN KEY ("courseId", "assignmentId") REFERENCES "Assignment"("courseId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegisteredGradingJobs" ADD CONSTRAINT "RegisteredGradingJobs_usersNetId_usersCourseId_fkey" FOREIGN KEY ("usersNetId", "usersCourseId") REFERENCES "Users"("netId", "courseId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishedGrades" ADD CONSTRAINT "PublishedGrades_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishedGrades" ADD CONSTRAINT "PublishedGrades_netId_courseId_fkey" FOREIGN KEY ("netId", "courseId") REFERENCES "Users"("netId", "courseId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishedGrades" ADD CONSTRAINT "PublishedGrades_courseId_assignmentId_fkey" FOREIGN KEY ("courseId", "assignmentId") REFERENCES "Assignment"("courseId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StagingGrades" ADD CONSTRAINT "StagingGrades_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "RegisteredGradingJobs"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StagingGrades" ADD CONSTRAINT "StagingGrades_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StagingGrades" ADD CONSTRAINT "StagingGrades_usersNetId_usersCourseId_fkey" FOREIGN KEY ("usersNetId", "usersCourseId") REFERENCES "Users"("netId", "courseId") ON DELETE NO ACTION ON UPDATE CASCADE;
