CREATE TABLE "GithubUsernameMapping" (
    "courseId" TEXT NOT NULL,
    "netId" TEXT NOT NULL,
    "githubUsername" TEXT NOT NULL,
    "githubName" TEXT,
    "minedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GithubUsernameMapping_pkey" PRIMARY KEY ("courseId", "netId")
);
CREATE UNIQUE INDEX "GithubUsernameMapping_courseId_githubUsername_key" ON "GithubUsernameMapping"("courseId", "githubUsername");
ALTER TABLE "GithubUsernameMapping" ADD CONSTRAINT "GithubUsernameMapping_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GithubUsernameMapping" ADD CONSTRAINT "GithubUsernameMapping_netId_courseId_fkey" FOREIGN KEY ("netId", "courseId") REFERENCES "Users"("netId", "courseId") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ProjectRepoPool" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "projectKey" TEXT NOT NULL,
    "repoName" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProjectRepoPool_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProjectRepoPool_courseId_projectKey_repoName_key" ON "ProjectRepoPool"("courseId", "projectKey", "repoName");
CREATE UNIQUE INDEX "ProjectRepoPool_courseId_projectKey_sortOrder_key" ON "ProjectRepoPool"("courseId", "projectKey", "sortOrder");
CREATE INDEX "ProjectRepoPool_courseId_projectKey_sortOrder_idx" ON "ProjectRepoPool"("courseId", "projectKey", "sortOrder");
ALTER TABLE "ProjectRepoPool" ADD CONSTRAINT "ProjectRepoPool_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ProjectRepoAssignment" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "projectKey" TEXT NOT NULL,
    "netId" TEXT NOT NULL,
    "repoName" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedBy" TEXT NOT NULL,
    "sourcePartnerGroupId" TEXT,
    "releasedAt" TIMESTAMP(3),
    "releasedBy" TEXT,
    CONSTRAINT "ProjectRepoAssignment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ProjectRepoAssignment_courseId_projectKey_netId_idx" ON "ProjectRepoAssignment"("courseId", "projectKey", "netId");
CREATE INDEX "ProjectRepoAssignment_courseId_projectKey_repoName_idx" ON "ProjectRepoAssignment"("courseId", "projectKey", "repoName");
CREATE UNIQUE INDEX "ProjectRepoAssignment_active_key" ON "ProjectRepoAssignment" ("courseId", "projectKey", "netId") WHERE "releasedAt" IS NULL;
ALTER TABLE "ProjectRepoAssignment" ADD CONSTRAINT "ProjectRepoAssignment_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectRepoAssignment" ADD CONSTRAINT "ProjectRepoAssignment_netId_courseId_fkey" FOREIGN KEY ("netId", "courseId") REFERENCES "Users"("netId", "courseId") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "ProjectRepoAssignment" ADD CONSTRAINT "ProjectRepoAssignment_courseId_projectKey_repoName_fkey" FOREIGN KEY ("courseId", "projectKey", "repoName") REFERENCES "ProjectRepoPool"("courseId", "projectKey", "repoName") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProjectRepoAssignment" ADD CONSTRAINT "ProjectRepoAssignment_sourcePartnerGroupId_fkey" FOREIGN KEY ("sourcePartnerGroupId") REFERENCES "PartnerGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ProjectRepoAssignmentAuditLog" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "projectKey" TEXT NOT NULL,
    "netId" TEXT NOT NULL,
    "oldRepoName" TEXT,
    "newRepoName" TEXT,
    "action" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,
    CONSTRAINT "ProjectRepoAssignmentAuditLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ProjectRepoAssignmentAuditLog_courseId_projectKey_netId_idx" ON "ProjectRepoAssignmentAuditLog"("courseId", "projectKey", "netId");

CREATE TABLE "GradeAuditLog" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "netId" TEXT NOT NULL,
    "oldScore" DOUBLE PRECISION,
    "newScore" DOUBLE PRECISION,
    "oldComments" TEXT,
    "newComments" TEXT,
    "changedBy" TEXT NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "justification" TEXT,
    CONSTRAINT "GradeAuditLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "GradeAuditLog_courseId_assignmentId_netId_idx" ON "GradeAuditLog"("courseId", "assignmentId", "netId");

CREATE TYPE "GradingMode" AS ENUM ('AUTOGRADED', 'MANUAL');

ALTER TABLE "Assignment" ADD COLUMN "projectKey" TEXT;
ALTER TABLE "Assignment" ADD COLUMN "gradingMode" "GradingMode";
UPDATE "Assignment" SET "gradingMode" = 'AUTOGRADED' WHERE "finalGradingRunId" IS NOT NULL;
UPDATE "Assignment" SET "gradingMode" = 'MANUAL' WHERE "finalGradingRunId" IS NULL;
ALTER TABLE "Assignment" ALTER COLUMN "gradingMode" SET NOT NULL;
ALTER TABLE "Assignment" ADD CONSTRAINT "assignment_projectkey_project_only" CHECK (category = 'PROJECT' OR "projectKey" IS NULL);
CREATE INDEX "Assignment_courseId_category_projectKey_idx" ON "Assignment"("courseId", "category", "projectKey");

ALTER TABLE "GradeAuditLog" ADD CONSTRAINT "GradeAuditLog_courseId_assignmentId_fkey" FOREIGN KEY ("courseId", "assignmentId") REFERENCES "Assignment"("courseId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GradeAuditLog" ADD CONSTRAINT "GradeAuditLog_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GradeAuditLog" ADD CONSTRAINT "GradeAuditLog_netId_courseId_fkey" FOREIGN KEY ("netId", "courseId") REFERENCES "Users"("netId", "courseId") ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION raise_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'audit log is append-only'; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER grade_audit_log_immutable BEFORE UPDATE OR DELETE ON "GradeAuditLog" FOR EACH ROW EXECUTE FUNCTION raise_immutable();
CREATE TRIGGER project_repo_audit_log_immutable BEFORE UPDATE OR DELETE ON "ProjectRepoAssignmentAuditLog" FOR EACH ROW EXECUTE FUNCTION raise_immutable();
