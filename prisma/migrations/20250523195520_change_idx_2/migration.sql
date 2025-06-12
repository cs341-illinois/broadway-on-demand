-- DropIndex
DROP INDEX "Users_courseId_netId_idx";

-- DropIndex
DROP INDEX "Users_courseId_uin_idx";

-- DropIndex
DROP INDEX "Users_netId_idx";

-- CreateIndex
CREATE INDEX "AttendanceRecord_courseId_weekId_createdBy_idx" ON "AttendanceRecord"("courseId", "weekId", "createdBy");

-- CreateIndex
CREATE INDEX "Users_netId_enabled_idx" ON "Users"("netId", "enabled");

-- CreateIndex
CREATE INDEX "Users_courseId_netId_enabled_idx" ON "Users"("courseId", "netId", "enabled");

-- CreateIndex
CREATE INDEX "Users_courseId_uin_enabled_idx" ON "Users"("courseId", "uin", "enabled");
