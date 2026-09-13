import { Prisma, PrismaClient, Category } from "../generated/prisma/client.js";
import { type RedisClientType } from "redis";
import { type FastifyBaseLogger } from "fastify";

type Tx = Prisma.TransactionClient;

const SYSTEM_ACTOR = "system-reconcile";
const REDIS_LOCK_PX = 30000;

export type ReconcileClaimed = {
  groupId: string;
  repoName: string;
  netIds: string[];
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
};

type PoolRow = { id: string; repoName: string };

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
 * Reconciles project-repo assignments for a projectKey against active Round-1
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
  };

  const activeGroups = await tx.partnerGroup.findMany({
    where: { courseId, roundNumber: 1, archivedAt: null },
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
        reason: `appears in ${groups.size} active Round-1 groups`,
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
): Promise<void> {
  const repoName = await claimFreeRepo(tx, courseId, projectKey);
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
      repoName,
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
      newRepoName: repoName,
      action: "claim",
      actor: SYSTEM_ACTOR,
      reason: `reconcile: new claim for group ${groupId}`,
    })),
  });
  summary.claimed.push({ groupId, repoName, netIds: memberNetIds });
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
  const repoName = await claimFreeRepo(tx, courseId, projectKey);
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
      reason: `reconcile: stale-suppression realign to fresh repo for group ${groupId}`,
    })),
  });
  summary.claimed.push({ groupId, repoName, netIds: targetNetIds });
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
