import { FastifyPluginAsync } from "fastify";
import { FastifyZodOpenApiTypeProvider } from "fastify-zod-openapi";
import { z } from "zod";
import { Role } from "../generated/prisma/client.js";
import { Category } from "../generated/prisma/enums.js";
import { ConflictError, DatabaseFetchError, ValidationError } from "../errors/index.js";
import { reconcileProjectRepoAssignments } from "../functions/projectRepos.js";

const courseParams = z.object({ courseId: z.string().min(1) });

const projectKeyParams = z.object({
  courseId: z.string().min(1),
  projectKey: z.string().min(1),
});

const projectEntry = z.object({ projectKey: z.string().min(1) });

const freeRepoEntry = z.object({
  repoName: z.string().min(1),
  sortOrder: z.number().int(),
});

const garbageRepoEntry = z.object({
  repoName: z.string().min(1),
  assignedNetIds: z.array(z.string()),
  reason: z.string(),
});

const conflictEntry = z.object({
  partnerGroupId: z.string().min(1),
  members: z.array(
    z.object({
      netId: z.string(),
      repoName: z.string().nullable(),
    }),
  ),
});

const gapEntry = z.object({
  partnerGroupId: z.string().min(1),
  members: z.array(z.object({ netId: z.string() })),
});

const assignmentEntry = z.object({
  netId: z.string(),
  repoName: z.string().min(1),
  partnerGroupId: z.string().nullable(),
  assignedAt: z.string(),
});

const projectReposStatusResponse = z.object({
  freeRepos: z.array(freeRepoEntry),
  garbageRepos: z.array(garbageRepoEntry),
  conflicts: z.array(conflictEntry),
  gaps: z.array(gapEntry),
  assignments: z.array(assignmentEntry),
});

const releaseBody = z.object({ repoName: z.string().min(1) });

const releaseResponse = z.object({
  released: z.number().int(),
  warning: z.string(),
});

function sessionNetId(request: { session: { user?: { email: string } } }): string {
  return request.session.user!.email.replace("@illinois.edu", "");
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function consensusRepo(counts: Map<string, number>): string | null {
  if (counts.size === 0) return null;
  let best: string | null = null;
  let bestCount = 0;
  let tie = false;
  for (const [repo, count] of counts) {
    if (count > bestCount) {
      best = repo;
      bestCount = count;
      tie = false;
    } else if (count === bestCount) {
      tie = true;
    }
  }
  return tie ? null : best;
}

const projectRepoRoutes: FastifyPluginAsync = async (fastify, _options) => {
  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().get(
    "/:courseId/projects",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.STAFF,
          Role.ADMIN,
        ]);
      },
      schema: {
        params: courseParams,
        response: { 200: z.array(projectEntry) },
      },
    },
    async (request, reply) => {
      const { courseId } = request.params;
      const rows = await fastify.prismaClient.assignment.findMany({
        where: { courseId, category: Category.PROJECT, projectKey: { not: null } },
        select: { projectKey: true },
        distinct: ["projectKey"],
      });
      const projectKeys = rows
        .map((r) => r.projectKey)
        .filter((pk): pk is string => pk !== null)
        .sort();
      return reply.status(200).send(projectKeys.map((projectKey) => ({ projectKey })));
    },
  );

  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().get(
    "/:courseId/:projectKey/status",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.STAFF,
          Role.ADMIN,
        ]);
      },
      schema: {
        params: projectKeyParams,
        response: { 200: projectReposStatusResponse },
      },
    },
    async (request, reply) => {
      const { courseId, projectKey } = request.params;

      const [pool, allAssignments, groups, enabledStudents] = await Promise.all([
        fastify.prismaClient.projectRepoPool.findMany({
          where: { courseId, projectKey },
          orderBy: { sortOrder: "asc" },
          select: { repoName: true, sortOrder: true },
        }),
        fastify.prismaClient.projectRepoAssignment.findMany({
          where: { courseId, projectKey },
          select: {
            netId: true,
            repoName: true,
            sourcePartnerGroupId: true,
            assignedAt: true,
            releasedAt: true,
          },
        }),
        fastify.prismaClient.partnerGroup.findMany({
          where: { courseId, roundNumber: 1, archivedAt: null },
          include: { members: { select: { netId: true } } },
        }),
        fastify.prismaClient.users.findMany({
          where: { courseId, role: Role.STUDENT, enabled: true },
          select: { netId: true },
        }),
      ]);

      const enabledNetIds = new Set(enabledStudents.map((s) => s.netId));

      const activeAssignments = allAssignments.filter((a) => a.releasedAt === null);
      const assignmentsByRepo = new Map<string, typeof activeAssignments>();
      const allAssignmentsByRepo = new Map<string, typeof allAssignments>();
      const activeAssignmentByNetId = new Map<
        string,
        { netId: string; repoName: string; sourcePartnerGroupId: string | null; assignedAt: Date }
      >();
      for (const a of activeAssignments) {
        activeAssignmentByNetId.set(a.netId, a);
        const list = assignmentsByRepo.get(a.repoName) ?? [];
        list.push(a);
        assignmentsByRepo.set(a.repoName, list);
      }
      for (const a of allAssignments) {
        const list = allAssignmentsByRepo.get(a.repoName) ?? [];
        list.push(a);
        allAssignmentsByRepo.set(a.repoName, list);
      }

      const activeGroups: { id: string; members: string[] }[] = [];
      const groupByNetId = new Map<string, (typeof activeGroups)[number]>();
      for (const g of groups) {
        const members = g.members
          .filter((m) => enabledNetIds.has(m.netId))
          .map((m) => m.netId);
        if (members.length === 0) continue;
        const entry = { id: g.id, members };
        activeGroups.push(entry);
        for (const netId of members) {
          if (!groupByNetId.has(netId)) groupByNetId.set(netId, entry);
        }
      }

      const groupConsensus = new Map<string, string | null>();
      for (const g of activeGroups) {
        const counts = new Map<string, number>();
        for (const netId of g.members) {
          const a = activeAssignmentByNetId.get(netId);
          if (a) counts.set(a.repoName, (counts.get(a.repoName) ?? 0) + 1);
        }
        groupConsensus.set(g.id, consensusRepo(counts));
      }

      // Free = pool rows never assigned; released rows stay out until reclaimed.
      const freeRepos = pool
        .filter((p) => !allAssignmentsByRepo.has(p.repoName))
        .map((p) => ({ repoName: p.repoName, sortOrder: p.sortOrder }));

      const garbageRepos: z.infer<typeof garbageRepoEntry>[] = [];

      // Garbage case 1: only released assignments remain (reclaimable).
      for (const [repoName, repoAssignments] of allAssignmentsByRepo) {
        const hasActive = repoAssignments.some((a) => a.releasedAt === null);
        if (!hasActive) {
          garbageRepos.push({
            repoName,
            assignedNetIds: repoAssignments.map((a) => a.netId),
            reason: "all assignments released (reclaimable)",
          });
          continue;
        }
      }

      // Garbage case 2: active assignments but all members stale or moved on.
      for (const [repoName, repoAssignments] of assignmentsByRepo) {
        let allStaleOrGone = true;
        const reasons: string[] = [];
        for (const a of repoAssignments) {
          const g = groupByNetId.get(a.netId);
          if (g) {
            const consensus = groupConsensus.get(g.id);
            if (consensus === repoName) {
              allStaleOrGone = false;
              break;
            } else if (consensus === null) {
              allStaleOrGone = false;
              break;
            }
            reasons.push(
              `${a.netId}: in active group ${g.id} (consensus ${consensus})`,
            );
          } else {
            reasons.push(
              `${a.netId}: ${enabledNetIds.has(a.netId) ? "not in any active Round-1 group" : "disabled/dropped"}`,
            );
          }
        }
        if (allStaleOrGone) {
          garbageRepos.push({
            repoName,
            assignedNetIds: repoAssignments.map((a) => a.netId),
            reason: reasons.join("; ") || "no active group members",
          });
        }
      }

      const conflicts: z.infer<typeof conflictEntry>[] = [];
      const gaps: z.infer<typeof gapEntry>[] = [];
      for (const g of activeGroups) {
        const repos = new Set<string>();
        const unassigned: string[] = [];
        for (const netId of g.members) {
          const a = activeAssignmentByNetId.get(netId);
          if (a) repos.add(a.repoName);
          else unassigned.push(netId);
        }
        if (repos.size >= 2) {
          conflicts.push({
            partnerGroupId: g.id,
            members: g.members.map((netId) => ({
              netId,
              repoName: activeAssignmentByNetId.get(netId)?.repoName ?? null,
            })),
          });
        } else if (unassigned.length > 0) {
          gaps.push({
            partnerGroupId: g.id,
            members: unassigned.map((netId) => ({ netId })),
          });
        }
      }

      const assignmentsOut = activeAssignments
        .map((a) => ({
          netId: a.netId,
          repoName: a.repoName,
          partnerGroupId: a.sourcePartnerGroupId ?? null,
          assignedAt: a.assignedAt.toISOString(),
        }))
        .sort(
          (a, b) =>
            a.repoName.localeCompare(b.repoName) || a.netId.localeCompare(b.netId),
        );

      return reply.status(200).send({
        freeRepos,
        garbageRepos,
        conflicts,
        gaps,
        assignments: assignmentsOut,
      });
    },
  );

  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().post(
    "/:courseId/:projectKey/release",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.ADMIN,
        ]);
      },
      schema: {
        params: projectKeyParams,
        body: releaseBody,
        response: { 200: releaseResponse },
      },
    },
    async (request, reply) => {
      const { courseId, projectKey } = request.params;
      const { repoName } = request.body;
      const actorNetId = sessionNetId(request);

      const released = await fastify.prismaClient.$transaction(async (tx) => {
        const active = await tx.projectRepoAssignment.findMany({
          where: { courseId, projectKey, repoName, releasedAt: null },
          select: { netId: true },
        });
        if (active.length === 0) {
          throw new ValidationError({
            message: `No active assignments for repo ${repoName} in project ${projectKey}.`,
          });
        }
        const netIds = active.map((a) => a.netId);

        const activeRound1Groups = await tx.partnerGroup.findMany({
          where: { courseId, roundNumber: 1, archivedAt: null },
          select: { members: { select: { netId: true } } },
        });
        const activeGroupNetIds = new Set<string>();
        for (const g of activeRound1Groups) {
          for (const m of g.members) activeGroupNetIds.add(m.netId);
        }
        const enabledUsers = await tx.users.findMany({
          where: { courseId, netId: { in: netIds }, enabled: true },
          select: { netId: true },
        });
        const blocking = enabledUsers
          .map((u) => u.netId)
          .filter((n) => activeGroupNetIds.has(n));
        if (blocking.length > 0) {
          throw new ConflictError({
            message: `Cannot release ${repoName}: ${blocking.join(", ")} are enabled and in an active Round-1 group.`,
          });
        }

        const now = new Date();
        await tx.projectRepoAssignment.updateMany({
          where: { courseId, projectKey, repoName, releasedAt: null },
          data: { releasedAt: now, releasedBy: actorNetId },
        });
        await tx.projectRepoAssignmentAuditLog.createMany({
          data: netIds.map((netId) => ({
            courseId,
            projectKey,
            netId,
            oldRepoName: repoName,
            newRepoName: null,
            action: "release",
            actor: actorNetId,
            reason: "manual release by admin",
          })),
        });
        return netIds.length;
      });

      request.log.info(
        { courseId, projectKey, repoName, released, actorNetId },
        "Project repo released",
      );

      return reply.status(200).send({
        released,
        warning:
          "Broadway cannot verify or wipe the repo's actual GitHub content. Manually remove collaborators from GitHub if needed.",
      });
    },
  );

  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().post(
    "/:courseId/:projectKey/reclaim",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.ADMIN,
        ]);
      },
      schema: {
        params: projectKeyParams,
        body: releaseBody,
        response: { 200: releaseResponse },
      },
    },
    async (request, reply) => {
      const { courseId, projectKey } = request.params;
      const { repoName } = request.body;
      const actorNetId = sessionNetId(request);

      const reclaimed = await fastify.prismaClient.$transaction(async (tx) => {
        // Only repos with released (non-active) assignments can be reclaimed.
        const released = await tx.projectRepoAssignment.findMany({
          where: { courseId, projectKey, repoName, releasedAt: { not: null } },
          select: { id: true, netId: true },
        });
        if (released.length === 0) {
          throw new ValidationError({
            message: `No released assignments for repo ${repoName} in project ${projectKey}.`,
          });
        }

        // Defense-in-depth: refuse if any released netId is enabled and in an active group.
        const activeRound1Groups = await tx.partnerGroup.findMany({
          where: { courseId, roundNumber: 1, archivedAt: null },
          select: { members: { select: { netId: true } } },
        });
        const activeGroupNetIds = new Set<string>();
        for (const g of activeRound1Groups) {
          for (const m of g.members) activeGroupNetIds.add(m.netId);
        }
        const enabledUsers = await tx.users.findMany({
          where: {
            courseId,
            netId: { in: released.map((a) => a.netId) },
            enabled: true,
          },
          select: { netId: true },
        });
        const blocking = enabledUsers
          .map((u) => u.netId)
          .filter((n) => activeGroupNetIds.has(n));
        if (blocking.length > 0) {
          throw new ConflictError({
            message: `Cannot reclaim ${repoName}: ${blocking.join(", ")} are enabled and in an active Round-1 group. Release first.`,
          });
        }

        const netIds = released.map((a) => a.netId);

        // Hard-delete released rows; audit log preserves history, repo re-enters the free pool.
        await tx.projectRepoAssignment.deleteMany({
          where: { courseId, projectKey, repoName, releasedAt: { not: null } },
        });

        await tx.projectRepoAssignmentAuditLog.createMany({
          data: netIds.map((netId) => ({
            courseId,
            projectKey,
            netId,
            oldRepoName: repoName,
            newRepoName: null,
            action: "reclaim",
            actor: actorNetId,
            reason: "reclaimed from garbage by admin",
          })),
        });
        return netIds.length;
      });

      request.log.info(
        { courseId, projectKey, repoName, reclaimed, actorNetId },
        "Project repo reclaimed from garbage",
      );

      return reply.status(200).send({
        released: reclaimed,
        warning:
          "Repo returned to the free pool. Broadway cannot verify or wipe the repo's actual GitHub content.",
      });
    },
  );

  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().get(
    "/:courseId/:projectKey/export",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.ADMIN,
        ]);
      },
      schema: {
        params: projectKeyParams,
      },
    },
    async (request, reply) => {
      const { courseId, projectKey } = request.params;
      const actorNetId = sessionNetId(request);

      const assignments = await fastify.prismaClient.projectRepoAssignment.findMany({
        where: { courseId, projectKey, releasedAt: null },
        select: { netId: true, repoName: true },
      });
      const mappings = await fastify.prismaClient.githubUsernameMapping.findMany({
        where: {
          courseId,
          netId: { in: assignments.length ? assignments.map((a) => a.netId) : ["__none__"] },
        },
        select: { netId: true, githubUsername: true },
      });

      const usernameByNetId = new Map(
        mappings.map((m) => [m.netId, m.githubUsername]),
      );

      const rows = assignments
        .map((a) => ({
          groupID: a.repoName,
          netId: a.netId,
          githubUsername: usernameByNetId.get(a.netId) ?? "",
          repoName: a.repoName,
        }))
        .sort(
          (a, b) =>
            a.repoName.localeCompare(b.repoName) || a.netId.localeCompare(b.netId),
        );

      const header = "groupID,netId,githubUsername,repoName";
      const lines = rows.map((r) =>
        [r.groupID, r.netId, r.githubUsername, r.repoName].map(csvEscape).join(","),
      );
      const csv = [header, ...lines].join("\n");

      request.log.info(
        { courseId, projectKey, rows: rows.length, actorNetId },
        "Project repo CSV export downloaded",
      );

      reply.header("Content-Type", "text/csv");
      reply.header(
        "Content-Disposition",
        `attachment; filename="project_${projectKey}_export.csv"`,
      );
      return reply.status(200).send(csv);
    },
  );

  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().post(
    "/:courseId/:projectKey/reconcile",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.ADMIN,
        ]);
      },
      schema: {
        params: projectKeyParams,
        response: { 200: z.object({
          projectKey: z.string(),
          claimed: z.number(),
          extended: z.number(),
          conflicts: z.number(),
          gaps: z.number(),
        }) },
      },
    },
    async (request, reply) => {
      const { courseId, projectKey } = request.params;

      const summary = await fastify.prismaClient
        .$transaction(async (tx) => {
          return await reconcileProjectRepoAssignments({ tx, courseId, projectKey });
        })
        .catch((e) => {
          if (e instanceof ConflictError || e instanceof ValidationError) throw e;
          request.log.error(e);
          throw new DatabaseFetchError({ message: "Reconciliation failed." });
        });

      request.log.info(
        { courseId, projectKey, summary },
        "Project repo reconciliation triggered manually",
      );

      return reply.status(200).send({
        projectKey: summary.projectKey,
        claimed: summary.claimed.length,
        extended: summary.extended.length,
        conflicts: summary.conflicts.length,
        gaps: summary.gaps.length,
      });
    },
  );
};

export default projectRepoRoutes;
