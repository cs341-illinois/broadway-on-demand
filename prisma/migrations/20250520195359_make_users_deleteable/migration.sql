-- DropForeignKey
ALTER TABLE "AttendanceRecord" DROP CONSTRAINT "AttendanceRecord_netId_courseId_fkey";

-- DropForeignKey
ALTER TABLE "ExtensionUsageHistory" DROP CONSTRAINT "ExtensionUsageHistory_netId_courseId_fkey";

-- DropForeignKey
ALTER TABLE "Extensions" DROP CONSTRAINT "Extensions_netId_courseId_fkey";

-- DropForeignKey
ALTER TABLE "Job" DROP CONSTRAINT "Job_usersNetId_usersCourseId_fkey";

-- DropForeignKey
ALTER TABLE "PublishedGrades" DROP CONSTRAINT "PublishedGrades_netId_courseId_fkey";

-- AlterTable
ALTER TABLE "AttendanceRecord" ADD COLUMN     "usersCourseId" TEXT,
ADD COLUMN     "usersNetId" TEXT;

-- AlterTable
ALTER TABLE "PublishedGrades" ADD COLUMN     "usersCourseId" TEXT,
ADD COLUMN     "usersNetId" TEXT;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_usersNetId_usersCourseId_fkey" FOREIGN KEY ("usersNetId", "usersCourseId") REFERENCES "Users"("netId", "courseId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishedGrades" ADD CONSTRAINT "PublishedGrades_usersNetId_usersCourseId_fkey" FOREIGN KEY ("usersNetId", "usersCourseId") REFERENCES "Users"("netId", "courseId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Extensions" ADD CONSTRAINT "Extensions_netId_courseId_fkey" FOREIGN KEY ("netId", "courseId") REFERENCES "Users"("netId", "courseId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtensionUsageHistory" ADD CONSTRAINT "ExtensionUsageHistory_netId_courseId_fkey" FOREIGN KEY ("netId", "courseId") REFERENCES "Users"("netId", "courseId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_usersNetId_usersCourseId_fkey" FOREIGN KEY ("usersNetId", "usersCourseId") REFERENCES "Users"("netId", "courseId") ON DELETE SET NULL ON UPDATE CASCADE;
