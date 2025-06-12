-- DropIndex
DROP INDEX "Job_courseId_assignmentId_type_idx";

-- CreateIndex
CREATE INDEX "Job_netId_courseId_assignmentId_type_idx" ON "Job"("netId", "courseId", "assignmentId", "type");
