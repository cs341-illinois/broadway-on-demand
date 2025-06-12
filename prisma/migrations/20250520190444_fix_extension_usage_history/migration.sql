-- DropForeignKey
ALTER TABLE "ExtensionUsageHistory" DROP CONSTRAINT "ExtensionUsageHistory_assignmentId_courseId_fkey";

-- AddForeignKey
ALTER TABLE "ExtensionUsageHistory" ADD CONSTRAINT "ExtensionUsageHistory_assignmentId_courseId_fkey" FOREIGN KEY ("assignmentId", "courseId") REFERENCES "Assignment"("id", "courseId") ON DELETE RESTRICT ON UPDATE CASCADE;
