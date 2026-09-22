import { Prisma, PrismaClient, Category } from "../generated/prisma/client.js";
import { type RedisClientType } from "redis";
import { type FastifyBaseLogger } from "fastify";
import { ConflictError, ValidationError } from "../errors/index.js";
import { getGroupForStudent } from "./partners.js";
import { createOrgRepo, addTeamRepoAccess } from "./github.js";

type Tx = Prisma.TransactionClient;

const SYSTEM_ACTOR = "system-reconcile";
const REDIS_LOCK_PX = 30000;
const ON_DEMAND_ACTOR = "system-provision";
// GitHub API throttle between provisioning calls (create repo, team grant).
const PROVISION_THROTTLE_MS = 300;

const TEAM_REPO_RE = /\.team-(\d+)$/;

export type ReconcileClaimed = {
  groupId: string;
  repoName: string;
  netIds: string[];
};

export type ReconcileProvisionPending = {
  repoName: string;
  netIds: string[];
  staffNetId?: string;
};

export type ReconcileExtended = {
  groupId: string;
  repoName: string;
  netIds: string[];
};

export type ReconcileConflict = {
  groupId: string;
  netIds: string[];
  repos: string[];
  reason: string;
};

export type ReconcileGap = {
  groupId: string;
  netIds: string[];
  reason: string;
};

export type ReconcileSkipped = {
  netId: string;
  reason: string;
};

export type ReconcileSummary = {
  projectKey: string;
  claimed: ReconcileClaimed[];
  extended: ReconcileExtended[];
  conflicts: ReconcileConflict[];
  gaps: ReconcileGap[];
  skipped: ReconcileSkipped[];
  // Pool rows created by this reconcile that still need their GitHub repo
  // created (on-demand mode only). The provisioner consumes these; rows are
  // tracked durably via ProjectRepoPool.provisionedAt IS NULL.
  provisionPending: ReconcileProvisionPending[];
};

export type ManualAssignResult = {
  netId: string;
  repoName: string;
  previousRepoName: string | null;
};

export type ManualAssignOutcome = {
  results: ManualAssignResult[];
  releasedBlockers: string[];
};

type PoolRow = { id: string; repoName: string };

/**
 * Per-project repo provisioning config. Defaults to the legacy POOL mode when
 * no config row exists (projects created before on-demand support).
 */
export async function getProjectRepoConfig({
  tx,
  courseId,
  projectKey,
}: {
  tx: Tx;
  courseId: string;
  projectKey: string;
}): Promise<{
  repoMode: "POOL" | "ON_DEMAND";
  repoProjectName: string | null;
  githubOrg: string | null;
}> {
  const row = await tx.projectRepoConfig.findUnique({
    where: { courseId_projectKey: { courseId, projectKey } },
    select: { repoMode: true, repoProjectName: true, githubOrg: true },
  });
  return {
    repoMode: row?.repoMode ?? "POOL",
    repoProjectName: row?.repoProjectName ?? null,
    githubOrg: row?.githubOrg ?? null,
  };
}

/**
 * The GitHub org this project's repos live in. Per-project override
 * (ProjectRepoConfig.githubOrg, used by on-demand projects in the dedicated
 * coursework org) wins; legacy POOL projects fall back to Course.githubOrg.
 */
export async function getProjectRepoOrg({
  tx,
  courseId,
  projectKey,
}: {
  tx: Tx;
  courseId: string;
  projectKey: string;
}): Promise<string> {
  const [config, course] = await Promise.all([
    tx.projectRepoConfig.findUnique({
      where: { courseId_projectKey: { courseId, projectKey } },
      select: { githubOrg: true },
    }),
    tx.course.findUniqueOrThrow({
      where: { id: courseId },
      select: { githubOrg: true },
    }),
  ]);
  return config?.githubOrg ?? course.githubOrg;
}

/**
 * The partner round a project's repo assignments reconcile against. A project
 * spans several Assignment rows sharing one projectKey; they all carry the
 * same partnerRoundNumber, so the first non-null value wins (round 1 fallback
 * for projects created without one).
 */
export async function getProjectRoundNumber({
  tx,
  courseId,
  projectKey,
}: {
  tx: Tx;
  courseId: string;
  projectKey: string;
}): Promise<number> {
  const rows = await tx.assignment.findMany({
    where: { courseId, projectKey },
    select: { partnerRoundNumber: true },
  });
  const round = rows.find((r) => r.partnerRoundNumber != null)
    ?.partnerRoundNumber;
  return round ?? 1;
}

/**
 * The GitHub team granted (maintain) access to on-demand project repos.
 * Falls back to the legacy `${githubRepoPrefix}_staff-team` slug convention
 * when no course-level override is set - matching what the collaborator sync
 * has always preserved.
 */
export function getStaffTeamSlug(course: {
  staffTeamSlug: string | null;
  githubRepoPrefix: string;
}): string {
  return course.staffTeamSlug ?? `${course.githubRepoPrefix}_staff-team`;
}

/**
 * Allocates the next unused `team-{NNN}` repo name for an on-demand project,
 * inserts its ProjectRepoPool row (provisionedAt: null - the GitHub repo does
 * not exist yet), and returns the name. The NNN sequence continues past any
 * existing pool rows for the projectKey; cross-projectKey name collisions are
 * skipped defensively.
 */
async function allocateOnDemandRepo(
  tx: Tx,
  courseId: string,
  projectKey: string,
  repoProjectName: string,
): Promise<string> {
  const course = await tx.course.findUniqueOrThrow({
    where: { id: courseId },
    select: { githubRepoPrefix: true },
  });
  const namePrefix = `${course.githubRepoPrefix}_.${repoProjectName}_.team-`;
  const rows = await tx.projectRepoPool.findMany({
    where: { courseId, projectKey, repoName: { startsWith: namePrefix } },
    select: { repoName: true },
  });
  let max = 0;
  for (const r of rows) {
    const m = TEAM_REPO_RE.exec(r.repoName);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  for (let n = max + 1; ; n++) {
    const repoName = `${namePrefix}${n.toString().padStart(3, "0")}`;
    const taken = await tx.projectRepoPool.findFirst({
      where: { courseId, repoName },
      select: { id: true },
    });
    if (!taken) {
      const maxSort = await tx.projectRepoPool.aggregate({
        where: { courseId, projectKey },
        _max: { sortOrder: true },
      });
      await tx.projectRepoPool.create({
        data: {
          courseId,
          projectKey,
          repoName,
          sortOrder: (maxSort._max.sortOrder ?? -1) + 1,
          provisionedAt: null,
        },
      });
      return repoName;
    }
  }
}

/**
 * On-demand pass: ensures every enabled STAFF/ADMIN user has a personal
 * `.staff-{netId}` repo for the project (pool row + assignment row, so the
 * repo is neither "free" for group claims nor blocked from test grading runs,
 * which require an active assignment). Idempotent; runs even when the project
 * has zero partner groups. Skips staff who already hold an active assignment
 * for the project (guards the one-active-assignment-per-netId DB invariant
 * for TAs who are also enrolled students).
 */
async function allocateOnDemandStaffRepos({
  tx,
  courseId,
  projectKey,
  repoProjectName,
  summary,
}: {
  tx: Tx;
  courseId: string;
  projectKey: string;
  repoProjectName: string;
  summary: ReconcileSummary;
}): Promise<void> {
  const course = await tx.course.findUniqueOrThrow({
    where: { id: courseId },
    select: { githubRepoPrefix: true },
  });
  const staff = await tx.users.findMany({
    where: {
      courseId,
      enabled: true,
      role: { in: ["STAFF", "ADMIN"] },
    },
    select: { netId: true },
    orderBy: { netId: "asc" },
  });

  for (const { netId } of staff) {
    const existing = await tx.projectRepoAssignment.findFirst({
      where: { courseId, projectKey, netId, releasedAt: null },
      select: { id: true },
    });
    if (existing) continue;

    const repoName = `${course.githubRepoPrefix}_.${repoProjectName}_.staff-${netId}`;
    const poolRow = await tx.projectRepoPool.findFirst({
      where: { courseId, projectKey, repoName },
      select: { id: true },
    });
    if (!poolRow) {
      const maxSort = await tx.projectRepoPool.aggregate({
        where: { courseId, projectKey },
        _max: { sortOrder: true },
      });
      await tx.projectRepoPool.create({
        data: {
          courseId,
          projectKey,
          repoName,
          sortOrder: (maxSort._max.sortOrder ?? -1) + 1,
          provisionedAt: null,
        },
      });
    }
    await tx.projectRepoAssignment.create({
      data: {
        courseId,
        projectKey,
        netId,
        repoName,
        assignedBy: ON_DEMAND_ACTOR,
        sourcePartnerGroupId: null,
      },
    });
    await tx.projectRepoAssignmentAuditLog.create({
      data: {
        courseId,
        projectKey,
        netId,
        oldRepoName: null,
        newRepoName: repoName,
        action: "claim",
        actor: ON_DEMAND_ACTOR,
        reason: `on-demand: staff repo allocation for ${netId}`,
      },
    });
    summary.provisionPending.push({
      repoName,
      netIds: [netId],
      staffNetId: netId,
    });
  }
}

/**
 * Claims the lowest-sortOrder free repo for the project, locking it FOR UPDATE
 * and re-verifying freeness after the lock to prevent concurrent double-claims.
 */
async function claimFreeRepo(
  tx: Tx,
  courseId: string,
  projectKey: string,
): Promise<string | null> {
  // "Free" means never assigned at all; released repos stay out of circulation until admin reclaims them.
  const candidates = (await tx.$queryRaw`
    SELECT p.id, p."repoName" FROM "ProjectRepoPool" p
    WHERE p."courseId" = ${courseId} AND p."projectKey" = ${projectKey}
      AND NOT EXISTS (
        SELECT 1 FROM "ProjectRepoAssignment" a
        WHERE a."courseId" = p."courseId"
          AND a."projectKey" = p."projectKey"
          AND a."repoName" = p."repoName"
      )
    ORDER BY p."sortOrder" ASC
  `) as PoolRow[];

  for (const candidate of candidates) {
    await tx.$queryRaw`SELECT id FROM "ProjectRepoPool" WHERE id = ${candidate.id} FOR UPDATE`;
    const taken = await tx.projectRepoAssignment.findFirst({
      where: { courseId, projectKey, repoName: candidate.repoName },
      select: { id: true },
    });
    if (!taken) {
      return candidate.repoName;
    }
  }
  return null;
}

/**
 * Returns a conflict reason if an active assignment for `repoName` belongs to a
 * netId now in a different active group (a split); null if safe to extend.
 */
async function checkSplitConflict(
  tx: Tx,
  courseId: string,
  projectKey: string,
  repoName: string,
  groupNetIdSet: Set<string>,
  groupId: string,
  netIdToGroupIds: Map<string, Set<string>>,
): Promise<string | null> {
  const existingForRepo = await tx.projectRepoAssignment.findMany({
    where: { courseId, projectKey, repoName, releasedAt: null },
    select: { netId: true },
  });
  for (const row of existingForRepo) {
    if (groupNetIdSet.has(row.netId)) continue;
    const groups = netIdToGroupIds.get(row.netId);
    if (groups && [...groups].some((gid) => gid !== groupId)) {
      return `repo '${repoName}' is also actively assigned to ${row.netId}, who is now in a different active group (split)`;
    }
  }
  return null;
}

/**
 * Manually assigns one or more netIds to a specific repoName, bypassing the
 * free-pool claim logic entirely — this is the escape hatch for repos that
 * already have history (e.g. re-assigning a student back to their own old
 * repo after their partner moved on) as well as ordinary manual fixes.
 *
 * For each netId: if they already have a different active assignment, it is
 * released and audit-logged before the new one is created (auto-relink,
 * mirroring how reconcile's realign functions behave). If they're already on
 * `repoName`, it's a no-op.
 *
 * If `repoName` is currently actively assigned to someone NOT in `netIds`,
 * the caller chooses the resolution via `displaceBlockers`: when true, those
 * holders are released (audit-logged) so the assignment can proceed — the
 * "assign this pair somewhere new" flow. When false, a ConflictError lists
 * the holders so the admin can release or include them explicitly.
 */
export async function manualAssignRepo({
  tx,
  courseId,
  projectKey,
  netIds,
  repoName,
  actorNetId,
  displaceBlockers = false,
}: {
  tx: Tx;
  courseId: string;
  projectKey: string;
  netIds: string[];
  repoName: string;
  actorNetId: string;
  displaceBlockers?: boolean;
}): Promise<ManualAssignOutcome> {
  const now = new Date();
  const pool = await tx.projectRepoPool.findFirst({
    where: { courseId, projectKey, repoName },
    select: { id: true },
  });
  if (!pool) {
    throw new ValidationError({
      message: `Repo '${repoName}' is not in the pool for project '${projectKey}'.`,
    });
  }

  const activeOnRepo = await tx.projectRepoAssignment.findMany({
    where: { courseId, projectKey, repoName, releasedAt: null },
    select: { netId: true },
  });
  const netIdSet = new Set(netIds);
  const blockers = activeOnRepo
    .map((a) => a.netId)
    .filter((n) => !netIdSet.has(n));
  const releasedBlockers: string[] = [];
  if (blockers.length > 0) {
    if (!displaceBlockers) {
      throw new ConflictError({
        message: `Repo '${repoName}' is already actively assigned to ${blockers.join(", ")}. Release them or include them in this assignment first.`,
      });
    }
    await tx.projectRepoAssignment.updateMany({
      where: {
        courseId,
        projectKey,
        repoName,
        releasedAt: null,
        netId: { in: blockers },
      },
      data: { releasedAt: now, releasedBy: actorNetId },
    });
    await tx.projectRepoAssignmentAuditLog.createMany({
      data: blockers.map((netId) => ({
        courseId,
        projectKey,
        netId,
        oldRepoName: repoName,
        newRepoName: null,
        action: "release",
        actor: actorNetId,
        reason: `manual reassignment: released to free '${repoName}' for ${netIds.join(", ")}`,
      })),
    });
    releasedBlockers.push(...blockers);
  }

  const results: ManualAssignResult[] = [];

  for (const netId of netIds) {
    const existingActive = await tx.projectRepoAssignment.findFirst({
      where: { courseId, projectKey, netId, releasedAt: null },
    });

    if (existingActive && existingActive.repoName === repoName) {
      results.push({ netId, repoName, previousRepoName: repoName });
      continue;
    }

    if (existingActive) {
      await tx.projectRepoAssignment.update({
        where: { id: existingActive.id },
        data: { releasedAt: now, releasedBy: actorNetId },
      });
      await tx.projectRepoAssignmentAuditLog.create({
        data: {
          courseId,
          projectKey,
          netId,
          oldRepoName: existingActive.repoName,
          newRepoName: null,
          action: "release",
          actor: actorNetId,
          reason: `manual reassignment: released before assigning to ${repoName}`,
        },
      });
    }

    const currentGroup = await getGroupForStudent({
      tx,
      courseId,
      netId,
      roundNumber: await getProjectRoundNumber({ tx, courseId, projectKey }),
    });

    await tx.projectRepoAssignment.create({
      data: {
        courseId,
        projectKey,
        netId,
        repoName,
        assignedBy: actorNetId,
        sourcePartnerGroupId: currentGroup?.id ?? null,
      },
    });
    await tx.projectRepoAssignmentAuditLog.create({
      data: {
        courseId,
        projectKey,
        netId,
        oldRepoName: existingActive?.repoName ?? null,
        newRepoName: repoName,
        action: "manual_assign",
        actor: actorNetId,
        reason: `manually assigned by ${actorNetId}`,
      },
    });

    results.push({
      netId,
      repoName,
      previousRepoName: existingActive?.repoName ?? null,
    });
  }

  return { results, releasedBlockers };
}

/**
 * Reconciles project-repo assignments for a projectKey against the project.s active partner-round
 * groups. Pool exhaustion is reported as a gap (not thrown) so callers can run
 * this fail-soft inside a group-edit transaction.
 */
export async function reconcileProjectRepoAssignments({
  tx,
  courseId,
  projectKey,
}: {
  tx: Tx;
  courseId: string;
  projectKey: string;
}): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = {
    projectKey,
    claimed: [],
    extended: [],
    conflicts: [],
    gaps: [],
    skipped: [],
    provisionPending: [],
  };

  const config = await getProjectRepoConfig({ tx, courseId, projectKey });
  const onDemand =
    config.repoMode === "ON_DEMAND" && config.repoProjectName
      ? { repoProjectName: config.repoProjectName }
      : undefined;
  const roundNumber = await getProjectRoundNumber({ tx, courseId, projectKey });

  const activeGroups = await tx.partnerGroup.findMany({
    where: { courseId, roundNumber, archivedAt: null },
    include: { members: { select: { netId: true } } },
    orderBy: { createdAt: "asc" },
  });

  const netIdToGroupIds = new Map<string, Set<string>>();
  for (const group of activeGroups) {
    for (const member of group.members) {
      const set = netIdToGroupIds.get(member.netId) ?? new Set();
      set.add(group.id);
      netIdToGroupIds.set(member.netId, set);
    }
  }
  const conflictedNetIds = new Set<string>();
  for (const [netId, groups] of netIdToGroupIds) {
    if (groups.size > 1) {
      conflictedNetIds.add(netId);
      summary.skipped.push({
        netId,
        reason: `appears in ${groups.size} active partner-round groups`,
      });
    }
  }

  for (const group of activeGroups) {
    const members = group.members.filter((m) => !conflictedNetIds.has(m.netId));
    if (members.length === 0) continue;

    const memberNetIds = members.map((m) => m.netId);
    const groupNetIdSet = new Set(memberNetIds);

    const assignments = await tx.projectRepoAssignment.findMany({
      where: {
        courseId,
        projectKey,
        netId: { in: memberNetIds },
        releasedAt: null,
      },
    });
    const netIdToAssignment = new Map(assignments.map((a) => [a.netId, a]));
    const allDistinctRepos = [...new Set(assignments.map((a) => a.repoName))];

    const sourceGroupIds = [
      ...new Set(
        assignments
          .map((a) => a.sourcePartnerGroupId)
          .filter((id): id is string => id !== null),
      ),
    ];
    const archivedSourceGroupIds = new Set<string>();
    if (sourceGroupIds.length > 0) {
      const sourceGroups = await tx.partnerGroup.findMany({
        where: { id: { in: sourceGroupIds } },
        select: { id: true, archivedAt: true },
      });
      for (const sg of sourceGroups) {
        if (sg.archivedAt !== null) archivedSourceGroupIds.add(sg.id);
      }
    }
    const isStale = (netId: string): boolean => {
      const a = netIdToAssignment.get(netId);
      if (!a || !a.sourcePartnerGroupId) return false;
      return archivedSourceGroupIds.has(a.sourcePartnerGroupId);
    };

    const realAssignments = assignments.filter((a) => !isStale(a.netId));
    const realDistinctRepos = [
      ...new Set(realAssignments.map((a) => a.repoName)),
    ];

    if (allDistinctRepos.length === 0) {
      await claimForGroup(
        tx,
        courseId,
        projectKey,
        group.id,
        memberNetIds,
        summary,
        onDemand,
      );
    } else if (allDistinctRepos.length === 1) {
      const repoName = allDistinctRepos[0];

      // All-stale assignments on the same repo: re-link sourcePartnerGroupId
      // instead of releasing and claiming a fresh repo. The group was
      // archived/recreated with the same membership but a new ID.
      if (realDistinctRepos.length === 0) {
        const staleNetIds = memberNetIds.filter((n) => isStale(n));
        await relinkStaleAssignments(
          tx,
          courseId,
          projectKey,
          group.id,
          staleNetIds,
          repoName,
        );
        continue;
      }

      const unassignedNetIds = memberNetIds.filter(
        (n) => !netIdToAssignment.has(n),
      );
      if (unassignedNetIds.length === 0) {
        // All members on the same repo; still check for cross-group split conflicts.
        const conflict = await checkSplitConflict(
          tx,
          courseId,
          projectKey,
          repoName,
          groupNetIdSet,
          group.id,
          netIdToGroupIds,
        );
        if (conflict) {
          summary.conflicts.push({
            groupId: group.id,
            netIds: memberNetIds,
            repos: [repoName],
            reason: conflict,
          });
        }
        continue;
      }

      const conflict = await checkSplitConflict(
        tx,
        courseId,
        projectKey,
        repoName,
        groupNetIdSet,
        group.id,
        netIdToGroupIds,
      );
      if (conflict) {
        summary.conflicts.push({
          groupId: group.id,
          netIds: memberNetIds,
          repos: [repoName],
          reason: conflict,
        });
      } else {
        await extendRepo(
          tx,
          courseId,
          projectKey,
          group.id,
          repoName,
          unassignedNetIds,
        );
        summary.extended.push({
          groupId: group.id,
          repoName,
          netIds: unassignedNetIds,
        });
      }
    } else {
      if (realDistinctRepos.length === 0) {
        const staleNetIds = memberNetIds.filter((n) => isStale(n));
        const staleRepos = [
          ...new Set(
            staleNetIds
              .map((n) => netIdToAssignment.get(n)?.repoName)
              .filter((r): r is string => !!r),
          ),
        ];
        if (staleRepos.length === 1) {
          // All stale but on the same repo — re-link instead of realign.
          await relinkStaleAssignments(
            tx,
            courseId,
            projectKey,
            group.id,
            staleNetIds,
            staleRepos[0],
          );
        } else {
          // Stale on different repos — genuine conflict, realign.
          const unassignedNetIds = memberNetIds.filter(
            (n) => !netIdToAssignment.has(n),
          );
          await realignToFreshRepo(
            tx,
            courseId,
            projectKey,
            group.id,
            staleNetIds,
            unassignedNetIds,
            netIdToAssignment,
            summary,
            onDemand,
          );
        }
      } else if (realDistinctRepos.length === 1) {
        const majorityRepo = realDistinctRepos[0];
        const conflict = await checkSplitConflict(
          tx,
          courseId,
          projectKey,
          majorityRepo,
          groupNetIdSet,
          group.id,
          netIdToGroupIds,
        );
        if (conflict) {
          summary.conflicts.push({
            groupId: group.id,
            netIds: memberNetIds,
            repos: [majorityRepo],
            reason: conflict,
          });
        } else {
          const staleNetIds = memberNetIds.filter((n) => isStale(n));
          const unassignedNetIds = memberNetIds.filter(
            (n) => !netIdToAssignment.has(n),
          );
          await realignToMajorityRepo(
            tx,
            courseId,
            projectKey,
            group.id,
            majorityRepo,
            staleNetIds,
            unassignedNetIds,
            netIdToAssignment,
          );
          summary.extended.push({
            groupId: group.id,
            repoName: majorityRepo,
            netIds: [...staleNetIds, ...unassignedNetIds],
          });
        }
      } else {
        summary.conflicts.push({
          groupId: group.id,
          netIds: memberNetIds,
          repos: realDistinctRepos,
          reason: `members on ${realDistinctRepos.length} different repos after stale suppression`,
        });
      }
    }
  }

  if (onDemand) {
    // Own pass so staff repos are allocated even when the project has no
    // active partner groups yet (e.g. right after project creation).
    await allocateOnDemandStaffRepos({
      tx,
      courseId,
      projectKey,
      repoProjectName: onDemand.repoProjectName,
      summary,
    });
  }

  return summary;
}

/**
 * Re-links stale assignments (whose sourcePartnerGroupId points to an archived
 * group) to the current active group, without releasing or moving repos.
 * Used when all stale assignments are already on the same repo — the group
 * was archived/recreated with identical membership but got a new ID.
 */
async function relinkStaleAssignments(
  tx: Tx,
  courseId: string,
  projectKey: string,
  groupId: string,
  staleNetIds: string[],
  repoName: string,
): Promise<void> {
  if (staleNetIds.length === 0) return;
  await tx.projectRepoAssignment.updateMany({
    where: {
      courseId,
      projectKey,
      netId: { in: staleNetIds },
      repoName,
      releasedAt: null,
    },
    data: { sourcePartnerGroupId: groupId },
  });
  await tx.projectRepoAssignmentAuditLog.createMany({
    data: staleNetIds.map((netId) => ({
      courseId,
      projectKey,
      netId,
      oldRepoName: repoName,
      newRepoName: repoName,
      action: "relink",
      actor: SYSTEM_ACTOR,
      reason: `reconcile: re-linked stale sourcePartnerGroupId to active group ${groupId}`,
    })),
  });
}

async function claimForGroup(
  tx: Tx,
  courseId: string,
  projectKey: string,
  groupId: string,
  memberNetIds: string[],
  summary: ReconcileSummary,
  onDemand?: { repoProjectName: string },
): Promise<void> {
  let repoName: string | null = null;
  if (onDemand) {
    // On-demand mode: allocate a fresh name + pool row; pool exhaustion is
    // impossible. The GitHub repo itself is created later by the provisioner.
    repoName = await allocateOnDemandRepo(
      tx,
      courseId,
      projectKey,
      onDemand.repoProjectName,
    );
  } else {
    repoName = await claimFreeRepo(tx, courseId, projectKey);
  }
  if (repoName === null) {
    summary.gaps.push({
      groupId,
      netIds: memberNetIds,
      reason: "pool exhausted — no free repo available",
    });
    return;
  }
  await tx.projectRepoAssignment.createMany({
    data: memberNetIds.map((netId) => ({
      courseId,
      projectKey,
      netId,
      repoName: repoName!,
      assignedBy: SYSTEM_ACTOR,
      sourcePartnerGroupId: groupId,
    })),
  });
  await tx.projectRepoAssignmentAuditLog.createMany({
    data: memberNetIds.map((netId) => ({
      courseId,
      projectKey,
      netId,
      oldRepoName: null,
      newRepoName: repoName!,
      action: "claim",
      actor: SYSTEM_ACTOR,
      reason: onDemand
        ? `reconcile: on-demand allocation for group ${groupId} (repo not yet provisioned)`
        : `reconcile: new claim for group ${groupId}`,
    })),
  });
  summary.claimed.push({ groupId, repoName, netIds: memberNetIds });
  if (onDemand) {
    summary.provisionPending.push({ repoName, netIds: memberNetIds });
  }
}

async function extendRepo(
  tx: Tx,
  courseId: string,
  projectKey: string,
  groupId: string,
  repoName: string,
  targetNetIds: string[],
): Promise<void> {
  await tx.projectRepoAssignment.createMany({
    data: targetNetIds.map((netId) => ({
      courseId,
      projectKey,
      netId,
      repoName,
      assignedBy: SYSTEM_ACTOR,
      sourcePartnerGroupId: groupId,
    })),
  });
  await tx.projectRepoAssignmentAuditLog.createMany({
    data: targetNetIds.map((netId) => ({
      courseId,
      projectKey,
      netId,
      oldRepoName: null,
      newRepoName: repoName,
      action: "extend",
      actor: SYSTEM_ACTOR,
      reason: `reconcile: extend to group ${groupId}`,
    })),
  });
}

async function realignToFreshRepo(
  tx: Tx,
  courseId: string,
  projectKey: string,
  groupId: string,
  staleNetIds: string[],
  unassignedNetIds: string[],
  netIdToAssignment: Map<
    string,
    { repoName: string; sourcePartnerGroupId: string | null }
  >,
  summary: ReconcileSummary,
  onDemand?: { repoProjectName: string },
): Promise<void> {
  const now = new Date();
  if (staleNetIds.length > 0) {
    await tx.projectRepoAssignment.updateMany({
      where: {
        courseId,
        projectKey,
        netId: { in: staleNetIds },
        releasedAt: null,
      },
      data: { releasedAt: now, releasedBy: SYSTEM_ACTOR },
    });
  }
  const targetNetIds = [...staleNetIds, ...unassignedNetIds];
  let repoName: string | null = null;
  if (onDemand) {
    repoName = await allocateOnDemandRepo(
      tx,
      courseId,
      projectKey,
      onDemand.repoProjectName,
    );
  } else {
    repoName = await claimFreeRepo(tx, courseId, projectKey);
  }
  if (repoName === null) {
    summary.gaps.push({
      groupId,
      netIds: targetNetIds,
      reason: "pool exhausted during stale-suppression realign",
    });
    return;
  }
  await tx.projectRepoAssignment.createMany({
    data: targetNetIds.map((netId) => ({
      courseId,
      projectKey,
      netId,
      repoName,
      assignedBy: SYSTEM_ACTOR,
      sourcePartnerGroupId: groupId,
    })),
  });
  await tx.projectRepoAssignmentAuditLog.createMany({
    data: targetNetIds.map((netId) => ({
      courseId,
      projectKey,
      netId,
      oldRepoName: netIdToAssignment.get(netId)?.repoName ?? null,
      newRepoName: repoName,
      action: "realign",
      actor: SYSTEM_ACTOR,
      reason: onDemand
        ? `reconcile: stale-suppression realign to fresh on-demand repo for group ${groupId} (repo not yet provisioned)`
        : `reconcile: stale-suppression realign to fresh repo for group ${groupId}`,
    })),
  });
  summary.claimed.push({ groupId, repoName, netIds: targetNetIds });
  if (onDemand) {
    summary.provisionPending.push({ repoName, netIds: targetNetIds });
  }
}

async function realignToMajorityRepo(
  tx: Tx,
  courseId: string,
  projectKey: string,
  groupId: string,
  majorityRepo: string,
  staleNetIds: string[],
  unassignedNetIds: string[],
  netIdToAssignment: Map<
    string,
    { repoName: string; sourcePartnerGroupId: string | null }
  >,
): Promise<void> {
  const now = new Date();
  if (staleNetIds.length > 0) {
    await tx.projectRepoAssignment.updateMany({
      where: {
        courseId,
        projectKey,
        netId: { in: staleNetIds },
        releasedAt: null,
      },
      data: { releasedAt: now, releasedBy: SYSTEM_ACTOR },
    });
  }
  const targetNetIds = [...staleNetIds, ...unassignedNetIds];
  if (targetNetIds.length === 0) return;
  await tx.projectRepoAssignment.createMany({
    data: targetNetIds.map((netId) => ({
      courseId,
      projectKey,
      netId,
      repoName: majorityRepo,
      assignedBy: SYSTEM_ACTOR,
      sourcePartnerGroupId: groupId,
    })),
  });
  const staleSet = new Set(staleNetIds);
  await tx.projectRepoAssignmentAuditLog.createMany({
    data: targetNetIds.map((netId) => ({
      courseId,
      projectKey,
      netId,
      oldRepoName: netIdToAssignment.get(netId)?.repoName ?? null,
      newRepoName: majorityRepo,
      action: staleSet.has(netId) ? "realign" : "extend",
      actor: SYSTEM_ACTOR,
      reason: `reconcile: stale-suppression realign to majority repo for group ${groupId}`,
    })),
  });
}

/**
 * Runs reconcileProjectRepoAssignments for every distinct PROJECT projectKey in
 * the course, inside the given transaction. Pool exhaustion is fail-soft.
 */
export async function reconcileAllProjectKeys({
  tx,
  courseId,
}: {
  tx: Tx;
  courseId: string;
}): Promise<ReconcileSummary[]> {
  const projectAssignments = await tx.assignment.findMany({
    where: { courseId, category: Category.PROJECT, projectKey: { not: null } },
    select: { projectKey: true },
  });
  const projectKeys = [
    ...new Set(
      projectAssignments
        .map((a) => a.projectKey)
        .filter((k): k is string => k !== null),
    ),
  ];
  const summaries: ReconcileSummary[] = [];
  for (const projectKey of projectKeys) {
    summaries.push(
      await reconcileProjectRepoAssignments({ tx, courseId, projectKey }),
    );
  }
  return summaries;
}

/**
 * Per-projectKey Redis-locked reconciliation entry point for the startup path,
 * when reconciliation is not sharing a transaction with a group write.
 */
export async function reconcileAllProjectKeysWithLock({
  prismaClient,
  redisClient,
  courseId,
  logger,
}: {
  prismaClient: PrismaClient;
  redisClient: RedisClientType;
  courseId: string;
  logger?: FastifyBaseLogger;
}): Promise<ReconcileSummary[]> {
  const projectAssignments = await prismaClient.assignment.findMany({
    where: { courseId, category: Category.PROJECT, projectKey: { not: null } },
    select: { projectKey: true },
  });
  const projectKeys = [
    ...new Set(
      projectAssignments
        .map((a) => a.projectKey)
        .filter((k): k is string => k !== null),
    ),
  ];

  const summaries: ReconcileSummary[] = [];
  for (const projectKey of projectKeys) {
    const lockKey = `projectrepo:claim:${courseId}:${projectKey}`;
    const lockTs = Date.now();
    const acquired = await redisClient.set(lockKey, lockTs, {
      NX: true,
      PX: REDIS_LOCK_PX,
    });
    if (!acquired) {
      logger?.warn(
        `Could not acquire Redis lock for ${lockKey}, skipping projectKey '${projectKey}'.`,
      );
      continue;
    }
    try {
      const summary = await prismaClient.$transaction(async (tx) => {
        return await reconcileProjectRepoAssignments({
          tx,
          courseId,
          projectKey,
        });
      });
      summaries.push(summary);
    } finally {
      const current = await redisClient.get(lockKey);
      if (current && parseInt(current, 10) === lockTs) {
        await redisClient.del(lockKey);
      }
    }
  }
  return summaries;
}

export type ProvisionResult = {
  // Repo names whose GitHub repo was confirmed to exist (created now or
  // already present) and that are now marked provisioned.
  provisioned: string[];
  failed: { repoName: string; error: string }[];
};

/**
 * Creates GitHub repos for every unprovisioned pool row of an on-demand
 * project (ProjectRepoPool.provisionedAt IS NULL) and grants the course's
 * staff team access to each. Intentionally GitHub-free everywhere else:
 * reconcile only allocates rows, this runs AFTER the allocating transaction
 * has committed.
 *
 * Idempotent/re-entrant (D3): takes the same Redis lock as reconcile, only
 * touches rows still unprovisioned (conditional UPDATE), treats GitHub's
 * "already exists" 422 as success, and on any failure leaves provisionedAt
 * NULL so a later run retries. A retry of a half-provisioned repo skips
 * creation and only re-attempts the team grant. Student collaborator invites
 * deliberately stay in the syncAccess flow (D1).
 */
export async function provisionPendingRepos({
  prismaClient,
  redisClient,
  courseId,
  projectKey,
  logger,
}: {
  prismaClient: PrismaClient;
  redisClient: RedisClientType;
  courseId: string;
  projectKey: string;
  logger: FastifyBaseLogger;
}): Promise<ProvisionResult> {
  const result: ProvisionResult = { provisioned: [], failed: [] };

  const config = await prismaClient.projectRepoConfig.findUnique({
    where: { courseId_projectKey: { courseId, projectKey } },
    select: { repoMode: true, githubOrg: true },
  });
  if (config?.repoMode !== "ON_DEMAND") {
    return result;
  }
  // Fail fast instead of silently targeting Course.githubOrg: on-demand
  // projects must declare their org explicitly (repo creation in the legacy
  // fallback org is typically not permitted - e.g. SAML-protected course
  // orgs), and a misconfiguration previously surfaced as uniform 403s on
  // every repo rather than a clear message.
  if (!config.githubOrg) {
    const pending = await prismaClient.projectRepoPool.findMany({
      where: { courseId, projectKey, provisionedAt: null },
      select: { repoName: true },
    });
    const message =
      "ProjectRepoConfig.githubOrg is not set for this on-demand project. " +
      "Set it via SQL or PUT /projectRepos/:courseId/:projectKey/config before provisioning.";
    logger?.warn(`Provisioning aborted for '${projectKey}': ${message}`);
    return {
      provisioned: [],
      failed: pending.map((p) => ({ repoName: p.repoName, error: message })),
    };
  }

  const lockKey = `projectrepo:claim:${courseId}:${projectKey}`;
  const lockTs = Date.now();
  const acquired = await redisClient.set(lockKey, lockTs, {
    NX: true,
    PX: REDIS_LOCK_PX,
  });
  if (!acquired) {
    logger?.warn(
      `Could not acquire Redis lock for ${lockKey}, skipping provisioning for '${projectKey}'.`,
    );
    return result;
  }

  try {
    const [repoOrg, course] = await Promise.all([
      getProjectRepoOrg({ tx: prismaClient, courseId, projectKey }),
      prismaClient.course.findUniqueOrThrow({
        where: { id: courseId },
        select: {
          githubToken: true,
          staffTeamSlug: true,
          githubRepoPrefix: true,
        },
      }),
    ]);
    const teamSlug = getStaffTeamSlug({
      staffTeamSlug: course.staffTeamSlug,
      githubRepoPrefix: course.githubRepoPrefix,
    });

    const pending = await prismaClient.projectRepoPool.findMany({
      where: { courseId, projectKey, provisionedAt: null },
      select: { repoName: true },
      orderBy: { sortOrder: "asc" },
    });

    for (const { repoName } of pending) {
      try {
        await createOrgRepo({
          githubToken: course.githubToken,
          orgName: repoOrg,
          repoName,
          logger,
        });
        await addTeamRepoAccess({
          githubToken: course.githubToken,
          orgName: repoOrg,
          teamSlug,
          repoName,
          logger,
        });
        await prismaClient.projectRepoPool.updateMany({
          where: { courseId, projectKey, repoName, provisionedAt: null },
          data: { provisionedAt: new Date() },
        });
        result.provisioned.push(repoName);
      } catch (e) {
        result.failed.push({ repoName, error: String(e) });
        logger?.warn(
          `Provisioning failed for ${repoName}: ${e} (will retry on next provision run)`,
        );
      }
      await new Promise((r) => setTimeout(r, PROVISION_THROTTLE_MS));
    }
  } finally {
    const current = await redisClient.get(lockKey);
    if (current && parseInt(current, 10) === lockTs) {
      await redisClient.del(lockKey);
    }
  }
  return result;
}
