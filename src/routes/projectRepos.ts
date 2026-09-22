import { FastifyPluginAsync } from "fastify";
import { FastifyZodOpenApiTypeProvider } from "fastify-zod-openapi";
import { z } from "zod";
import { Role } from "../generated/prisma/client.js";
import { Category } from "../generated/prisma/enums.js";
import {
  ConflictError,
  DatabaseFetchError,
  ValidationError,
} from "../errors/index.js";
import {
  reconcileProjectRepoAssignments,
  manualAssignRepo,
  provisionPendingRepos,
  getProjectRepoConfig,
  getProjectRepoOrg,
  getProjectRoundNumber,
  getStaffTeamSlug,
} from "../functions/projectRepos.js";
import {
  addRepoCollaborator,
  removeRepoCollaborator,
} from "../functions/github.js";

const courseParams = z.object({ courseId: z.string().min(1) });

const projectKeyParams = z.object({
  courseId: z.string().min(1),
  projectKey: z.string().min(1),
});

const projectEntry = z.object({
  projectKey: z.string().min(1),
  repoMode: z.enum(["POOL", "ON_DEMAND"]),
  repoProjectName: z.string().nullable(),
});

// Repo names allocated in the DB but not yet created on GitHub (on-demand
// projects) - drives the "Provision pending repos" affordance.
const pendingRepoEntry = z.object({ repoName: z.string().min(1) });

const freeRepoEntry = z.object({
  repoName: z.string().min(1),
  sortOrder: z.number().int(),
});

const garbageRepoEntry = z.object({
  repoName: z.string().min(1),
  assignedNetIds: z.array(z.string()),
  reason: z.string(),
  reclaimable: z.boolean(),
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
  githubAccessConfirmed: z.boolean(),
});

const projectReposStatusResponse = z.object({
  freeRepos: z.array(freeRepoEntry),
  garbageRepos: z.array(garbageRepoEntry),
  conflicts: z.array(conflictEntry),
  gaps: z.array(gapEntry),
  assignments: z.array(assignmentEntry),
  repoMode: z.enum(["POOL", "ON_DEMAND"]),
  pendingRepos: z.array(pendingRepoEntry),
});

const configBody = z.object({
  repoMode: z.enum(["POOL", "ON_DEMAND"]),
  // Required for ON_DEMAND (used in repo names); ignored/rejected-nonempty for POOL.
  repoProjectName: z
    .string()
    .regex(/^[a-z0-9_-]+$/, "Lowercase letters, digits, hyphens, underscores only")
    .nullable()
    .optional(),
  // GitHub org this project's repos live in. Null/omitted falls back to the
  // course's githubOrg (legacy POOL projects).
  githubOrg: z.string().min(1).nullable().optional(),
});

const releaseBody = z.object({ repoName: z.string().min(1) });

const assignBody = z.object({
  netIds: z.array(z.string().min(1)).min(1),
  repoName: z.string().min(1),
  displaceBlockers: z.boolean().optional().default(false),
});

const assignResultEntry = z.object({
  netId: z.string(),
  repoName: z.string(),
  previousRepoName: z.string().nullable(),
  githubAccessGranted: z.boolean(),
  githubAccessError: z.string().nullable(),
});

const assignResponse = z.object({
  results: z.array(assignResultEntry),
  releasedBlockers: z.array(z.string()),
  accessWarnings: z.array(z.string()),
});

const releaseResponse = z.object({
  released: z.number().int(),
  warning: z.string(),
});

function sessionNetId(request: {
  session: { user?: { email: string } };
}): string {
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
        where: {
          courseId,
          category: Category.PROJECT,
          projectKey: { not: null },
        },
        select: { projectKey: true },
        distinct: ["projectKey"],
      });
      const projectKeys = rows
        .map((r) => r.projectKey)
        .filter((pk): pk is string => pk !== null)
        .sort();
      const configs = await fastify.prismaClient.projectRepoConfig.findMany({
        where: { courseId, projectKey: { in: projectKeys } },
        select: { projectKey: true, repoMode: true, repoProjectName: true },
      });
      const configByKey = new Map(configs.map((c) => [c.projectKey, c]));
      return reply.status(200).send(
        projectKeys.map((projectKey) => ({
          projectKey,
          repoMode: configByKey.get(projectKey)?.repoMode ?? "POOL",
          repoProjectName: configByKey.get(projectKey)?.repoProjectName ?? null,
        })),
      );
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

      const projectRound = await getProjectRoundNumber({
        tx: fastify.prismaClient,
        courseId,
        projectKey,
      });
      const [pool, allAssignments, groups, enabledStudents] = await Promise.all(
        [
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
              githubAccessConfirmed: true,
            },
          }),
          fastify.prismaClient.partnerGroup.findMany({
            where: { courseId, roundNumber: projectRound, archivedAt: null },
            include: { members: { select: { netId: true } } },
          }),
          fastify.prismaClient.users.findMany({
            where: { courseId, role: Role.STUDENT, enabled: true },
            select: { netId: true },
          }),
        ],
      );

      const enabledNetIds = new Set(enabledStudents.map((s) => s.netId));

      const activeAssignments = allAssignments.filter(
        (a) => a.releasedAt === null,
      );
      const assignmentsByRepo = new Map<string, typeof activeAssignments>();
      const allAssignmentsByRepo = new Map<string, typeof allAssignments>();
      const activeAssignmentByNetId = new Map<
        string,
        {
          netId: string;
          repoName: string;
          sourcePartnerGroupId: string | null;
          assignedAt: Date;
        }
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
            reclaimable: true,
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
              `${a.netId}: ${enabledNetIds.has(a.netId) ? "not in any active partner-round group" : "disabled/dropped"}`,
            );
          }
        }
        if (allStaleOrGone) {
          garbageRepos.push({
            repoName,
            assignedNetIds: repoAssignments.map((a) => a.netId),
            reason: reasons.join("; ") || "no active group members",
            reclaimable: false,
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
          githubAccessConfirmed: a.githubAccessConfirmed,
        }))
        .sort(
          (a, b) =>
            a.repoName.localeCompare(b.repoName) ||
            a.netId.localeCompare(b.netId),
        );

      const config = await getProjectRepoConfig({
        tx: fastify.prismaClient,
        courseId,
        projectKey,
      });
      const pendingRepos =
        config.repoMode === "ON_DEMAND"
          ? await fastify.prismaClient.projectRepoPool.findMany({
              where: { courseId, projectKey, provisionedAt: null },
              select: { repoName: true },
              orderBy: { sortOrder: "asc" },
            })
          : [];

      return reply.status(200).send({
        freeRepos,
        garbageRepos,
        conflicts,
        gaps,
        assignments: assignmentsOut,
        repoMode: config.repoMode,
        pendingRepos,
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

        const activeGroups = await tx.partnerGroup.findMany({
          where: {
            courseId,
            roundNumber: await getProjectRoundNumber({ tx, courseId, projectKey }),
            archivedAt: null,
          },
          select: { members: { select: { netId: true } } },
        });
        const activeGroupNetIds = new Set<string>();
        for (const g of activeGroups) {
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
            message: `Cannot release ${repoName}: ${blocking.join(", ")} are enabled and in an active partner-round group.`,
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

      const assignments =
        await fastify.prismaClient.projectRepoAssignment.findMany({
          where: { courseId, projectKey, releasedAt: null },
          select: { netId: true, repoName: true },
        });
      const mappings =
        await fastify.prismaClient.githubUsernameMapping.findMany({
          where: {
            courseId,
            netId: {
              in: assignments.length
                ? assignments.map((a) => a.netId)
                : ["__none__"],
            },
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
            a.repoName.localeCompare(b.repoName) ||
            a.netId.localeCompare(b.netId),
        );

      const header = "groupID,netId,githubUsername,repoName";
      const lines = rows.map((r) =>
        [r.groupID, r.netId, r.githubUsername, r.repoName]
          .map(csvEscape)
          .join(","),
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
        response: {
          200: z.object({
            projectKey: z.string(),
            claimed: z.number(),
            extended: z.number(),
            conflicts: z.number(),
            gaps: z.number(),
            provisioned: z.number(),
            provisionFailed: z.number(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { courseId, projectKey } = request.params;

      const summary = await fastify.prismaClient
        .$transaction(async (tx) => {
          return await reconcileProjectRepoAssignments({
            tx,
            courseId,
            projectKey,
          });
        })
        .catch((e) => {
          if (e instanceof ConflictError || e instanceof ValidationError)
            throw e;
          request.log.error(e);
          throw new DatabaseFetchError({ message: "Reconciliation failed." });
        });

      request.log.info(
        { courseId, projectKey, summary },
        "Project repo reconciliation triggered manually",
      );

      // Post-commit provisioning: reconcile only allocated rows; the GitHub
      // repos are created here, outside the DB transaction.
      const provision = await provisionPendingRepos({
        prismaClient: fastify.prismaClient,
        redisClient: fastify.redisClient,
        courseId,
        projectKey,
        logger: request.log,
      });

      return reply.status(200).send({
        projectKey: summary.projectKey,
        claimed: summary.claimed.length,
        extended: summary.extended.length,
        conflicts: summary.conflicts.length,
        gaps: summary.gaps.length,
        provisioned: provision.provisioned.length,
        provisionFailed: provision.failed.length,
      });
    },
  );

  // Upserts the per-project provisioning config (repoMode + repoProjectName).
  // Mode changes are rejected once the project has any pool rows, so a
  // project never mixes imported pool repos with on-demand allocation.
  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().put(
    "/:courseId/:projectKey/config",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.ADMIN,
        ]);
      },
      schema: {
        params: projectKeyParams,
        body: configBody,
        response: {
          200: z.object({
            projectKey: z.string(),
            repoMode: z.enum(["POOL", "ON_DEMAND"]),
            repoProjectName: z.string().nullable(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { courseId, projectKey } = request.params;
      const { repoMode, repoProjectName, githubOrg } = request.body;

      if (repoMode === "ON_DEMAND" && !repoProjectName) {
        throw new ValidationError({
          message: "repoProjectName is required for ON_DEMAND projects.",
        });
      }

      const existingPoolCount =
        await fastify.prismaClient.projectRepoPool.count({
          where: { courseId, projectKey },
        });
      const existing = await fastify.prismaClient.projectRepoConfig.findUnique({
        where: { courseId_projectKey: { courseId, projectKey } },
      });
      if (
        existing &&
        existing.repoMode !== repoMode &&
        existingPoolCount > 0
      ) {
        throw new ConflictError({
          message: `Cannot change repoMode while the project has ${existingPoolCount} pool row(s).`,
        });
      }

      const saved = await fastify.prismaClient.projectRepoConfig.upsert({
        where: { courseId_projectKey: { courseId, projectKey } },
        create: {
          courseId,
          projectKey,
          repoMode,
          repoProjectName: repoProjectName ?? null,
          githubOrg: githubOrg ?? null,
        },
        update: {
          repoMode,
          repoProjectName: repoProjectName ?? null,
          githubOrg: githubOrg ?? null,
        },
      });

      return reply.status(200).send({
        projectKey,
        repoMode: saved.repoMode,
        repoProjectName: saved.repoProjectName,
      });
    },
  );

  // Creates GitHub repos for every allocated-but-unprovisioned pool row of an
  // on-demand project. Idempotent; safe to re-run (retry button).
  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().post(
    "/:courseId/:projectKey/provision",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.ADMIN,
        ]);
      },
      schema: {
        params: projectKeyParams,
        response: {
          200: z.object({
            provisioned: z.array(z.string()),
            failed: z.array(
              z.object({ repoName: z.string(), error: z.string() }),
            ),
          }),
        },
      },
    },
    async (request, reply) => {
      const { courseId, projectKey } = request.params;
      const result = await provisionPendingRepos({
        prismaClient: fastify.prismaClient,
        redisClient: fastify.redisClient,
        courseId,
        projectKey,
        logger: request.log,
      });
      return reply.status(200).send(result);
    },
  );

  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().post(
    "/:courseId/:projectKey/assign",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.ADMIN,
        ]);
      },
      schema: {
        params: projectKeyParams,
        body: assignBody,
        response: { 200: assignResponse },
      },
    },
    async (request, reply) => {
      const { courseId, projectKey } = request.params;
      const { netIds, repoName, displaceBlockers } = request.body;
      const actorNetId = sessionNetId(request);

      const { results, releasedBlockers } = await fastify.prismaClient
        .$transaction((tx) =>
          manualAssignRepo({
            tx,
            courseId,
            projectKey,
            netIds,
            repoName,
            actorNetId,
            displaceBlockers,
          }),
        )
        .catch((e) => {
          if (e instanceof ConflictError || e instanceof ValidationError)
            throw e;
          request.log.error(e);
          throw new DatabaseFetchError({
            message: "Manual repo assignment failed.",
          });
        });

      // Grant access one collaborator at a time — scoped to just the
      // students we touched, not the full project-wide syncAccess sweep.
      const [repoOrg, course] = await Promise.all([
        getProjectRepoOrg({
          tx: fastify.prismaClient,
          courseId,
          projectKey,
        }),
        fastify.prismaClient.course.findUniqueOrThrow({
          where: { id: courseId },
          select: { githubToken: true },
        }),
      ]);
      const mappings =
        await fastify.prismaClient.githubUsernameMapping.findMany({
          where: {
            courseId,
            netId: { in: [...netIds, ...releasedBlockers] },
          },
          select: { netId: true, githubUsername: true },
        });
      const usernameByNetId = new Map(
        mappings.map((m) => [m.netId, m.githubUsername]),
      );

      const grantResults: z.infer<typeof assignResultEntry>[] = [];
      for (const r of results) {
        const username = usernameByNetId.get(r.netId);
        if (!username) {
          grantResults.push({
            ...r,
            githubAccessGranted: false,
            githubAccessError: "No GitHub username mapping found.",
          });
          continue;
        }
        try {
          await addRepoCollaborator({
            githubToken: course.githubToken,
            orgName: repoOrg,
            repoName: r.repoName,
            username,
            logger: request.log,
          });
          await fastify.prismaClient.projectRepoAssignment.updateMany({
            where: {
              courseId,
              projectKey,
              netId: r.netId,
              repoName: r.repoName,
              releasedAt: null,
            },
            data: { githubAccessConfirmed: true },
          });
          grantResults.push({
            ...r,
            githubAccessGranted: true,
            githubAccessError: null,
          });
        } catch (e: any) {
          request.log.error(
            { err: e.message, netId: r.netId, repoName: r.repoName },
            "Failed to grant GitHub access after manual assign",
          );
          grantResults.push({
            ...r,
            githubAccessGranted: false,
            githubAccessError: e.message || "Unknown error",
          });
        }
      }

      // Best-effort: strip GitHub access from anyone we just released, so
      // displaced holders never keep push rights to a repo they lost.
      const accessWarnings: string[] = [];
      for (const netId of releasedBlockers) {
        const username = usernameByNetId.get(netId);
        if (!username) {
          accessWarnings.push(
            `${netId}: no GitHub username mapping — remove manually if needed`,
          );
          continue;
        }
        try {
          await removeRepoCollaborator({
            githubToken: course.githubToken,
            orgName: repoOrg,
            repoName,
            username,
            logger: request.log,
          });
        } catch (e: any) {
          accessWarnings.push(`${netId} (${username}): ${e.message}`);
        }
      }

      // Same for auto-relink: a netId that moved off a previous repo must not
      // keep push access to the repo they left behind.
      for (const r of grantResults) {
        if (!r.previousRepoName || r.previousRepoName === repoName) continue;
        const username = usernameByNetId.get(r.netId);
        if (!username) {
          accessWarnings.push(
            `${r.netId}: no GitHub username mapping — remove manually from ${r.previousRepoName} if needed`,
          );
          continue;
        }
        try {
          await removeRepoCollaborator({
            githubToken: course.githubToken,
            orgName: repoOrg,
            repoName: r.previousRepoName,
            username,
            logger: request.log,
          });
        } catch (e: any) {
          accessWarnings.push(
            `${r.netId} (${username}) from ${r.previousRepoName}: ${e.message}`,
          );
        }
      }

      request.log.info(
        {
          courseId,
          projectKey,
          netIds,
          repoName,
          actorNetId,
          displaceBlockers,
          releasedBlockers,
          accessWarnings,
          results: grantResults,
        },
        "Manual project repo assignment",
      );

      return reply.status(200).send({
        results: grantResults,
        releasedBlockers,
        accessWarnings,
      });
    },
  );

  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().post(
    "/:courseId/:projectKey/syncAccess",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.ADMIN,
        ]);
      },
      schema: {
        params: projectKeyParams,
        response: {
          200: z.object({
            confirmed: z.number(),
            added: z.number(),
            removed: z.number(),
            noMapping: z.number(),
            failed: z.number(),
            total: z.number(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { courseId, projectKey } = request.params;

      const [repoOrg, course] = await Promise.all([
        getProjectRepoOrg({
          tx: fastify.prismaClient,
          courseId,
          projectKey,
        }),
        fastify.prismaClient.course.findUniqueOrThrow({
          where: { id: courseId },
          select: {
            githubToken: true,
            githubRepoPrefix: true,
            staffTeamSlug: true,
          },
        }),
      ]);

      const staffTeam = getStaffTeamSlug(course);
      // Preserve both the configured staff team and the legacy
      // `{prefix}_staff-team` convention: older repos may carry the legacy
      // team's access, and removing team entries via the collaborators API
      // is unreliable — never sweep either.
      const preservedTeamSlugs = new Set([
        staffTeam,
        `${course.githubRepoPrefix}_staff-team`,
      ]);

      const assignments =
        await fastify.prismaClient.projectRepoAssignment.findMany({
          where: { courseId, projectKey, releasedAt: null },
          select: {
            id: true,
            netId: true,
            repoName: true,
            githubAccessConfirmed: true,
          },
        });

      const netIds = [...new Set(assignments.map((a) => a.netId))];
      const mappings =
        await fastify.prismaClient.githubUsernameMapping.findMany({
          where: { courseId, netId: { in: netIds } },
          select: { netId: true, githubUsername: true },
        });
      const usernameByNetId = new Map(
        mappings.map((m) => [m.netId, m.githubUsername]),
      );

      // Group assignments by repo for per-repo collaborator management
      const assignmentsByRepo = new Map<string, typeof assignments>();
      for (const a of assignments) {
        const list = assignmentsByRepo.get(a.repoName) ?? [];
        list.push(a);
        assignmentsByRepo.set(a.repoName, list);
      }

      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

      const ghHeaders = {
        Authorization: `Bearer ${course.githubToken}`,
        Accept: "application/vnd.github+json",
      };

      let confirmed = 0;
      let added = 0;
      let removed = 0;
      let noMapping = 0;
      let failed = 0;

      for (const [repoName, repoAssignments] of assignmentsByRepo) {
        // Build the set of GitHub usernames that SHOULD have access
        const expectedUsernames = new Set<string>();
        let repoHasNoMapping = false;
        for (const a of repoAssignments) {
          const username = usernameByNetId.get(a.netId);
          if (!username) {
            repoHasNoMapping = true;
            noMapping++;
          } else {
            expectedUsernames.add(username);
          }
        }

        try {
          // List current direct collaborators on the repo
          let currentCollaborators: string[] = [];
          let page = 1;
          while (true) {
            const listRes = await fetch(
              `https://api.github.com/repos/${repoOrg}/${repoName}/collaborators?affiliation=direct&per_page=100&page=${page}`,
              { headers: ghHeaders },
            );
            if (listRes.status !== 200) {
              throw new Error(`List collaborators failed: ${listRes.status}`);
            }
            const collabs = (await listRes.json()) as { login: string }[];
            for (const c of collabs) {
              currentCollaborators.push(c.login);
            }
            if (collabs.length < 100) break;
            page++;
            await sleep(300);
          }

          // Add missing assigned students
          for (const a of repoAssignments) {
            const username = usernameByNetId.get(a.netId);
            if (!username) continue;

            if (a.githubAccessConfirmed) {
              confirmed++;
              continue;
            }

            if (currentCollaborators.includes(username)) {
              confirmed++;
            } else {
              const addRes = await fetch(
                `https://api.github.com/repos/${repoOrg}/${repoName}/collaborators/${username}`,
                {
                  method: "PUT",
                  headers: { ...ghHeaders, "Content-Type": "application/json" },
                  body: JSON.stringify({ permission: "push" }),
                },
              );
              if (addRes.status !== 201 && addRes.status !== 204) {
                throw new Error(`Add failed: ${addRes.status} for ${username}`);
              }
              added++;
              currentCollaborators.push(username);
            }

            await fastify.prismaClient.projectRepoAssignment.update({
              where: { id: a.id },
              data: { githubAccessConfirmed: true },
            });
            await sleep(300);
          }

          // Remove collaborators who shouldn't have access (preserve staff team)
          for (const login of currentCollaborators) {
            if (preservedTeamSlugs.has(login)) continue;
            if (expectedUsernames.has(login)) continue;

            const removeRes = await fetch(
              `https://api.github.com/repos/${repoOrg}/${repoName}/collaborators/${login}`,
              { method: "DELETE", headers: ghHeaders },
            );
            if (removeRes.status !== 204) {
              request.log.warn(
                { repoName, login, status: removeRes.status },
                "Failed to remove stale collaborator",
              );
              continue;
            }
            removed++;
            await sleep(300);
          }
        } catch (e: any) {
          request.log.error(
            { repoName, err: e.message },
            "Failed to sync GitHub access for repo",
          );
          failed += repoAssignments.length - (repoHasNoMapping ? 0 : 0);
        }
      }

      request.log.info(
        {
          courseId,
          projectKey,
          confirmed,
          added,
          removed,
          noMapping,
          failed,
          total: assignments.length,
        },
        "GitHub access sync completed",
      );

      return reply.status(200).send({
        confirmed,
        added,
        removed,
        noMapping,
        failed,
        total: assignments.length,
      });
    },
  );
};

export default projectRepoRoutes;
