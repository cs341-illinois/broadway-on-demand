-- Add githubInviteSentAt to ProjectRepoAssignment: tracks an invitation that
-- is open on GitHub awaiting acceptance (sync-derived tri-state with
-- githubAccessConfirmed).
ALTER TABLE "ProjectRepoAssignment" ADD COLUMN "githubInviteSentAt" TIMESTAMP(3);
