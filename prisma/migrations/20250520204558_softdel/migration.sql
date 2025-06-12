/*
  Warnings:

  - You are about to drop the column `usersCourseId` on the `AttendanceRecord` table. All the data in the column will be lost.
  - You are about to drop the column `usersNetId` on the `AttendanceRecord` table. All the data in the column will be lost.
  - You are about to drop the column `usersCourseId` on the `PublishedGrades` table. All the data in the column will be lost.
  - You are about to drop the column `usersNetId` on the `PublishedGrades` table. All the data in the column will be lost.
  - You are about to drop the column `usersCourseId` on the `StagingGrades` table. All the data in the column will be lost.
  - You are about to drop the column `usersNetId` on the `StagingGrades` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "AttendanceRecord" DROP CONSTRAINT "AttendanceRecord_usersNetId_usersCourseId_fkey";

-- DropForeignKey
ALTER TABLE "ExtensionUsageHistory" DROP CONSTRAINT "ExtensionUsageHistory_netId_courseId_fkey";

-- DropForeignKey
ALTER TABLE "Extensions" DROP CONSTRAINT "Extensions_netId_courseId_fkey";

-- DropForeignKey
ALTER TABLE "Job" DROP CONSTRAINT "Job_usersNetId_usersCourseId_fkey";

-- DropForeignKey
ALTER TABLE "PublishedGrades" DROP CONSTRAINT "PublishedGrades_usersNetId_usersCourseId_fkey";

-- DropForeignKey
ALTER TABLE "StagingGrades" DROP CONSTRAINT "StagingGrades_usersNetId_usersCourseId_fkey";

-- AlterTable
ALTER TABLE "AttendanceRecord" DROP COLUMN "usersCourseId",
DROP COLUMN "usersNetId";

-- AlterTable
ALTER TABLE "PublishedGrades" DROP COLUMN "usersCourseId",
DROP COLUMN "usersNetId";

-- AlterTable
ALTER TABLE "StagingGrades" DROP COLUMN "usersCourseId",
DROP COLUMN "usersNetId";

-- AlterTable
ALTER TABLE "Users" ADD COLUMN     "enabled" BOOLEAN NOT NULL DEFAULT true;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_usersNetId_usersCourseId_fkey" FOREIGN KEY ("usersNetId", "usersCourseId") REFERENCES "Users"("netId", "courseId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishedGrades" ADD CONSTRAINT "PublishedGrades_netId_courseId_fkey" FOREIGN KEY ("netId", "courseId") REFERENCES "Users"("netId", "courseId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StagingGrades" ADD CONSTRAINT "StagingGrades_netId_courseId_fkey" FOREIGN KEY ("netId", "courseId") REFERENCES "Users"("netId", "courseId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Extensions" ADD CONSTRAINT "Extensions_netId_courseId_fkey" FOREIGN KEY ("netId", "courseId") REFERENCES "Users"("netId", "courseId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtensionUsageHistory" ADD CONSTRAINT "ExtensionUsageHistory_netId_courseId_fkey" FOREIGN KEY ("netId", "courseId") REFERENCES "Users"("netId", "courseId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_netId_courseId_fkey" FOREIGN KEY ("netId", "courseId") REFERENCES "Users"("netId", "courseId") ON DELETE RESTRICT ON UPDATE CASCADE;
