import { FastifyPluginAsync } from "fastify";
import { FastifyZodOpenApiTypeProvider } from "fastify-zod-openapi";
import { z } from "zod";
import {
  AssignmentQuota,
  AssignmentVisibility,
  Category,
  GradingMode,
  Role,
} from "../generated/prisma/client.js";
import { getGroupForStudent } from "../functions/partners.js";
import { getCourseRoles, getUserRolesByNetId } from "../functions/userData.js";
import {
  createAssignmentWithFinalGradingJob,
  deleteAssignmentInTransaction,
} from "../functions/assignment.js";
import {
  BaseError,
  DatabaseFetchError,
  DatabaseInsertError,
  UnauthorizedError,
  ValidationError,
} from "../errors/index.js";

const projectComponentSchema = z.object({
  assignmentId: z.string(),
  name: z.string(),
  gradingMode: z.enum(["AUTOGRADED", "MANUAL"]),
  weight: z.number(),
});

const projectEntrySchema = z.object({
  projectKey: z.string(),
  components: z.array(projectComponentSchema),
});

const studentGradeEntrySchema = z.object({
  score: z.number().nullable(),
  comments: z.string().nullable(),
});

const studentRowSchema = z.object({
  netId: z.string(),
  name: z.string().nullable(),
  partnerGroupId: z.string().nullable(),
  groupMembers: z.array(z.string()),
  repoName: z.string().nullable(),
  grades: z.record(z.string(), studentGradeEntrySchema),
  combinedScore: z.number().nullable(),
});

const studentsQuerySchema = z.object({
  netId: z.optional(z.string().min(1)),
});

const projectKeyParamsSchema = z.object({
  courseId: z.string().min(1),
  projectKey: z.string().min(1),
});

function sessionNetId(request: { session: { user?: { email: string } } }): string {
  return request.session.user!.email.replace("@illinois.edu", "");
}

const projectGradesRoutes: FastifyPluginAsync = async (fastify, _options) => {
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
        params: z.object({ courseId: z.string().min(1) }),
        response: {
          200: z.array(projectEntrySchema),
        },
      },
    },
    async (request, reply) => {
      const { courseId } = request.params;
      const assignments = await fastify.prismaClient.assignment
        .findMany({
          where: {
            courseId,
            category: Category.PROJECT,
            projectKey: { not: null },
          },
          select: {
            id: true,
            name: true,
            gradingMode: true,
            weight: true,
            projectKey: true,
          },
          orderBy: { name: "asc" },
        })
        .catch((e) => {
          request.log.error(e);
          throw new DatabaseFetchError({
            message: "Failed to fetch PROJECT assignments.",
          });
        });

      const byKey = new Map<string, z.infer<typeof projectComponentSchema>[]>();
      for (const a of assignments) {
        const key = a.projectKey;
        if (!key) continue;
        const list = byKey.get(key) ?? [];
        list.push({
          assignmentId: a.id,
          name: a.name,
          gradingMode: a.gradingMode,
          weight: a.weight,
        });
        byKey.set(key, list);
      }

      const result = Array.from(byKey.entries())
        .map(([projectKey, components]) => ({ projectKey, components }))
        .sort((a, b) => a.projectKey.localeCompare(b.projectKey));

      return reply.status(200).send(result);
    },
  );

  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().get(
    "/:courseId/:projectKey/students",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.STAFF,
          Role.ADMIN,
        ]);
      },
      schema: {
        params: projectKeyParamsSchema,
        querystring: studentsQuerySchema,
        response: {
          200: z.array(studentRowSchema),
        },
      },
    },
    async (request, reply) => {
      const { courseId, projectKey } = request.params;
      const netIdFilter = request.query.netId;
      const callerNetId = sessionNetId(request);

      const components = await fastify.prismaClient.assignment
        .findMany({
          where: {
            courseId,
            category: Category.PROJECT,
            projectKey,
          },
          select: {
            id: true,
            name: true,
            gradingMode: true,
            weight: true,
            partnerRoundNumber: true,
          },
          orderBy: { name: "asc" },
        })
        .catch((e) => {
          request.log.error(e);
          throw new DatabaseFetchError({
            message: "Failed to fetch project components.",
          });
        });

      const roundNumber = components[0]?.partnerRoundNumber ?? null;
      if (roundNumber == null) {
        throw new ValidationError({
          message:
            "This project has no partner round configured. Set a Partner Round on the assignment before entering grades.",
        });
      }

      const courseRoles = getCourseRoles(courseId, request.session.user!.roles);
      const isAdmin = courseRoles.includes(Role.ADMIN);

      let staffLabSection: string | null = null;
      if (!isAdmin) {
        const staffUser = await fastify.prismaClient.users
          .findUnique({
            where: { netId_courseId: { netId: callerNetId, courseId } },
            select: { labSection: true },
          })
          .catch((e) => {
            request.log.error(e);
            throw new DatabaseFetchError({
              message: "Failed to fetch staff user.",
            });
          });
        staffLabSection = staffUser?.labSection ?? null;
        if (!staffLabSection) {
          throw new UnauthorizedError({
            message: "Staff user has no lab section assigned.",
          });
        }
      }

      const groups = await fastify.prismaClient.partnerGroup
        .findMany({
          where: {
            courseId,
            roundNumber,
            archivedAt: null,
            ...(staffLabSection ? { labSection: staffLabSection } : {}),
          },
          include: {
            members: { include: { Users: { select: { name: true } } } },
          },
          orderBy: [{ labSection: "asc" }, { createdAt: "asc" }],
        })
        .catch((e) => {
          request.log.error(e);
          throw new DatabaseFetchError({
            message: "Failed to fetch partner groups.",
          });
        });

      const memberNetIds = groups.flatMap((g) =>
        g.members.map((m) => m.netId),
      );
      const targetNetIds = netIdFilter
        ? memberNetIds.filter((n) => n === netIdFilter)
        : memberNetIds;
      const targetSet = new Set(targetNetIds);

      const repoAssignments =
        targetNetIds.length > 0
          ? await fastify.prismaClient.projectRepoAssignment
              .findMany({
                where: {
                  courseId,
                  projectKey,
                  netId: { in: targetNetIds },
                  releasedAt: null,
                },
                select: { netId: true, repoName: true },
              })
              .catch((e) => {
                request.log.error(e);
                throw new DatabaseFetchError({
                  message: "Failed to fetch project repo assignments.",
                });
              })
          : [];
      const repoByNetId = new Map(
        repoAssignments.map((r) => [r.netId, r.repoName]),
      );

      const componentIds = components.map((c) => c.id);
      const grades =
        targetNetIds.length > 0 && componentIds.length > 0
          ? await fastify.prismaClient.publishedGrades
              .findMany({
                where: {
                  courseId,
                  assignmentId: { in: componentIds },
                  netId: { in: targetNetIds },
                },
                select: {
                  netId: true,
                  assignmentId: true,
                  score: true,
                  comments: true,
                },
              })
              .catch((e) => {
                request.log.error(e);
                throw new DatabaseFetchError({
                  message: "Failed to fetch current grades.",
                });
              })
          : [];
      const gradeByKey = new Map<
        string,
        { score: number; comments: string | null }
      >();
      for (const g of grades) {
        gradeByKey.set(`${g.netId}:${g.assignmentId}`, {
          score: g.score,
          comments: g.comments,
        });
      }

      const result = [];
      for (const group of groups) {
        for (const member of group.members) {
          if (!targetSet.has(member.netId)) continue;
          const gradesObj: Record<
            string,
            { score: number | null; comments: string | null }
          > = {};
          let combinedScore: number | null = components.length === 0 ? null : 0;
          let incomplete = false;
          for (const comp of components) {
            const g = gradeByKey.get(`${member.netId}:${comp.id}`);
            const score = g ? g.score : null;
            const comments = g ? g.comments : null;
            gradesObj[comp.id] = { score, comments };
            if (score === null) {
              incomplete = true;
            } else if (combinedScore !== null) {
              combinedScore += (score * comp.weight) / 100;
            }
          }
          if (incomplete) combinedScore = null;
          else if (combinedScore !== null)
            combinedScore = Math.round(combinedScore * 100) / 100;
          result.push({
            netId: member.netId,
            name: member.Users.name,
            partnerGroupId: group.id,
            groupMembers: group.members
              .filter((m) => m.netId !== member.netId)
              .map((m) => m.netId),
            repoName: repoByNetId.get(member.netId) ?? null,
            grades: gradesObj,
            combinedScore,
          });
        }
      }

      return reply.status(200).send(result);
    },
  );

  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().post(
    "/:courseId/:assignmentId/group/:partnerGroupId/grade",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.STAFF,
          Role.ADMIN,
        ]);
      },
      schema: {
        params: z.object({
          courseId: z.string().min(1),
          assignmentId: z.string().min(1),
          partnerGroupId: z.string().min(1),
        }),
        body: z.object({
          score: z.number().min(0).max(100),
          comments: z.optional(z.string().nullable()),
          justification: z.string().min(1),
        }),
        response: {
          201: z.null(),
        },
      },
    },
    async (request, reply) => {
      const { courseId, assignmentId, partnerGroupId } = request.params;
      const { score, comments, justification } = request.body;
      const callerNetId = sessionNetId(request);

      // Re-fetch roles; the session cache may lag the fire-and-forget refresh and let revoked STAFF through.
      const freshRoles = await getUserRolesByNetId(callerNetId).catch((e) => {
        request.log.error(e);
        throw new DatabaseFetchError({
          message: "Failed to look up caller roles.",
        });
      });
      const freshCourseRoles = freshRoles
        .filter((r) => r.courseId === courseId)
        .map((r) => r.role);
      const isFreshAdmin = freshCourseRoles.includes(Role.ADMIN);
      const isFreshStaff = freshCourseRoles.includes(Role.STAFF);
      if (!isFreshAdmin && !isFreshStaff) {
        throw new UnauthorizedError({
          message: "You do not have permission to enter grades for this course.",
        });
      }

      const assignment = await fastify.prismaClient.assignment
        .findFirst({
          where: { courseId, id: assignmentId },
          select: {
            gradingMode: true,
            partnerRoundNumber: true,
            projectKey: true,
          },
        })
        .catch((e) => {
          request.log.error(e);
          throw new DatabaseFetchError({
            message: "Failed to fetch assignment.",
          });
        });
      if (!assignment) {
        throw new ValidationError({ message: "Assignment not found." });
      }
      if (assignment.gradingMode !== GradingMode.MANUAL) {
        throw new ValidationError({
          message:
            "Grades can only be entered for manually-graded assignments.",
        });
      }
      const roundNumber = assignment.partnerRoundNumber;
      if (roundNumber == null) {
        throw new ValidationError({
          message:
            "This assignment has no partner round configured. Set a Partner Round before entering grades.",
        });
      }

      let staffLabSection: string | null = null;
      if (!isFreshAdmin) {
        const staffUser = await fastify.prismaClient.users
          .findUnique({
            where: { netId_courseId: { netId: callerNetId, courseId } },
            select: { labSection: true },
          })
          .catch((e) => {
            request.log.error(e);
            throw new DatabaseFetchError({
              message: "Failed to fetch staff user.",
            });
          });
        staffLabSection = staffUser?.labSection ?? null;
        if (!staffLabSection) {
          throw new UnauthorizedError({
            message: "Staff user has no lab section assigned.",
          });
        }
      }

      const normalizedComments = comments ?? null;

      await fastify.prismaClient
        .$transaction(async (tx) => {
          // Re-resolve the current group via getGroupForStudent to reject stale/archived partner groups.
          const bridgeMember = await tx.partnerGroupMember.findFirst({
            where: { partnerGroupId },
            select: { netId: true },
          });
          if (!bridgeMember) {
            throw new ValidationError({
              message: "Partner group not found.",
            });
          }
          const group = await getGroupForStudent({
            tx,
            courseId,
            netId: bridgeMember.netId,
            roundNumber,
          });
          if (!group) {
            throw new ValidationError({
              message: "This partner group is no longer active.",
            });
          }
          if (group.id !== partnerGroupId) {
            throw new ValidationError({
              message:
                "This partner group has been updated. Please refresh and try again.",
            });
          }
          if (!isFreshAdmin) {
            if (!staffLabSection || group.labSection !== staffLabSection) {
              throw new UnauthorizedError({
                message:
                  "You can only enter grades for groups in your own lab section.",
              });
            }
          }

          const memberNetIds = group.members.map((m) => m.netId);
          const existing = await tx.publishedGrades.findMany({
            where: {
              courseId,
              assignmentId,
              netId: { in: memberNetIds },
            },
            select: { netId: true, score: true, comments: true },
          });
          const existingByNetId = new Map(
            existing.map((g) => [g.netId, g]),
          );

          const auditRows: {
            courseId: string;
            assignmentId: string;
            netId: string;
            oldScore: number | null;
            newScore: number;
            oldComments: string | null;
            newComments: string | null;
            changedBy: string;
            justification: string;
          }[] = [];

          for (const netId of memberNetIds) {
            const old = existingByNetId.get(netId);
            const oldScore = old ? old.score : null;
            const oldComments = old ? old.comments : null;
            await tx.publishedGrades.upsert({
              where: {
                courseId_assignmentId_netId: {
                  courseId,
                  assignmentId,
                  netId,
                },
              },
              update: {
                score,
                comments: normalizedComments,
              },
              create: {
                courseId,
                assignmentId,
                netId,
                score,
                comments: normalizedComments,
              },
            });
            auditRows.push({
              courseId,
              assignmentId,
              netId,
              oldScore,
              newScore: score,
              oldComments,
              newComments: normalizedComments,
              changedBy: callerNetId,
              justification,
            });
          }

          if (auditRows.length > 0) {
            await tx.gradeAuditLog.createMany({ data: auditRows });
          }
        })
        .catch((e) => {
          if (e instanceof BaseError) {
            throw e;
          }
          request.log.error(e);
          throw new DatabaseInsertError({
            message: "Failed to enter grade.",
          });
        });

      return reply.status(201).send();
    },
  );

  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().patch(
    "/:courseId/:projectKey/weights",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.ADMIN,
        ]);
      },
      schema: {
        params: projectKeyParamsSchema,
        body: z.object({
          components: z.array(
            z.object({
              assignmentId: z.string().min(1),
              weight: z.number().min(0),
            }),
          ),
        }),
        response: {
          200: z.null(),
        },
      },
    },
    async (request, reply) => {
      const { courseId, projectKey } = request.params;
      const { components } = request.body;

      const total = components.reduce((sum, c) => sum + c.weight, 0);
      if (Math.abs(total - 100) > 0.001) {
        throw new ValidationError({
          message: `Weights must sum to 100 (currently ${total}).`,
        });
      }

      const existing = await fastify.prismaClient.assignment
        .findMany({
          where: { courseId, projectKey },
          select: { id: true },
        })
        .catch((e) => {
          request.log.error(e);
          throw new DatabaseFetchError({
            message: "Failed to fetch project components.",
          });
        });
      const existingIds = new Set(existing.map((a) => a.id));
      for (const c of components) {
        if (!existingIds.has(c.assignmentId)) {
          throw new ValidationError({
            message: `Assignment ${c.assignmentId} does not belong to project ${projectKey}.`,
          });
        }
      }

      await fastify.prismaClient
        .$transaction(
          components.map((c) =>
            fastify.prismaClient.assignment.update({
              where: { courseId_id: { courseId, id: c.assignmentId } },
              data: { weight: c.weight },
            }),
          ),
        )
        .catch((e) => {
          if (e instanceof BaseError) {
            throw e;
          }
          request.log.error(e);
          throw new DatabaseInsertError({
            message: "Failed to update project weights.",
          });
        });

      return reply.status(200).send();
    },
  );

  const componentSyncItemSchema = z.object({
    // Present = update an existing component; absent = create a new one.
    assignmentId: z.string().min(1).optional(),
    name: z.string(),
    gradingMode: z.enum(["AUTOGRADED", "MANUAL"]),
    weight: z.number().min(0),
  });

  const syncComponentsBodySchema = z.object({
    components: z.array(componentSyncItemSchema).min(1),
  });

  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().put(
    "/:courseId/:projectKey/components",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.ADMIN,
        ]);
      },
      schema: {
        params: projectKeyParamsSchema,
        body: syncComponentsBodySchema,
        response: {
          200: z.null(),
        },
      },
    },
    async (request, reply) => {
      const { courseId, projectKey } = request.params;
      const { components } = request.body;

      // --- payload validation ---
      const trimmedNames = components.map((c) => c.name.trim());
      for (const [i, name] of trimmedNames.entries()) {
        if (!components[i].assignmentId && !name) {
          throw new ValidationError({
            message: "Every new component must have a name.",
          });
        }
      }
      const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
      if (Math.abs(totalWeight - 100) > 0.001) {
        throw new ValidationError({
          message: `Weights must sum to 100 (currently ${totalWeight}).`,
        });
      }

      // --- load existing components ---
      const existing = await fastify.prismaClient.assignment
        .findMany({
          where: { courseId, projectKey, category: Category.PROJECT },
          select: {
            id: true,
            name: true,
            gradingMode: true,
            partnerRoundNumber: true,
            quotaAmount: true,
            quotaPeriod: true,
            visibility: true,
            openAt: true,
            finalGradingRunId: true,
          },
        })
        .catch((e) => {
          request.log.error(e);
          throw new DatabaseFetchError({
            message: "Failed to fetch project components.",
          });
        });
      if (existing.length === 0) {
        throw new ValidationError({
          message: `Project "${projectKey}" not found.`,
        });
      }

      const existingById = new Map(existing.map((a) => [a.id, a]));
      const referencedIds = new Set<string>();
      for (const c of components) {
        if (!c.assignmentId) continue;
        if (referencedIds.has(c.assignmentId)) {
          throw new ValidationError({
            message: `Component ${c.assignmentId} appears more than once in the request.`,
          });
        }
        if (!existingById.has(c.assignmentId)) {
          throw new ValidationError({
            message: `Assignment ${c.assignmentId} does not belong to project ${projectKey}.`,
          });
        }
        referencedIds.add(c.assignmentId);
      }

      const kept = existing.filter((a) => referencedIds.has(a.id));
      const removed = existing.filter((a) => !referencedIds.has(a.id));
      const additions = components
        .map((c, i) => ({ ...c, trimmedName: trimmedNames[i] }))
        .filter((c) => !c.assignmentId);

      // --- invariants ---
      const autogradedCount =
        kept.filter((a) => a.gradingMode === GradingMode.AUTOGRADED).length +
        additions.filter((c) => c.gradingMode === "AUTOGRADED").length;
      if (autogradedCount === 0) {
        throw new ValidationError({
          message:
            "At least one component must be autograded (for repo assignment).",
        });
      }

      // Derived component IDs must be unique across kept rows and each other.
      const slugify = (name: string) =>
        name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
      const takenIds = new Set(kept.map((a) => a.id));
      const additionsWithIds = additions.map((c) => {
        const slug = slugify(c.trimmedName);
        if (!slug) {
          throw new ValidationError({
            message: `Component name "${c.trimmedName}" must contain letters or numbers.`,
          });
        }
        const id = `${projectKey}-${slug}`;
        if (takenIds.has(id)) {
          throw new ValidationError({
            message: `Component names must be unique — "${c.trimmedName}" would reuse ID "${id}".`,
          });
        }
        takenIds.add(id);
        return { ...c, id };
      });

      // --- removal guardrails: block components with grade/extension history ---
      const removedIds = removed.map((a) => a.id);
      if (removedIds.length > 0) {
        const gradedRows = await fastify.prismaClient.publishedGrades
          .findMany({
            where: { courseId, assignmentId: { in: removedIds } },
            select: { assignmentId: true },
            distinct: ["assignmentId"],
          })
          .catch((e) => {
            request.log.error(e);
            throw new DatabaseFetchError({
              message: "Failed to check existing grades.",
            });
          });
        const extensionRows = await fastify.prismaClient.extensionUsageHistory
          .findMany({
            where: { courseId, assignmentId: { in: removedIds } },
            select: { assignmentId: true },
            distinct: ["assignmentId"],
          })
          .catch((e) => {
            request.log.error(e);
            throw new DatabaseFetchError({
              message: "Failed to check existing extensions.",
            });
          });
        const blockedIds = new Set([
          ...gradedRows.map((g) => g.assignmentId),
          ...extensionRows.map((x) => x.assignmentId),
        ]);
        const blockedNames = removed
          .filter((a) => blockedIds.has(a.id))
          .map((a) => a.name);
        if (blockedNames.length > 0) {
          throw new ValidationError({
            message: `Cannot remove component(s) with existing grade or extension records: ${blockedNames.join(", ")}.`,
          });
        }
      }

      // --- inheritance template from an existing AG component ---
      const agTemplate =
        kept.find((a) => a.gradingMode === GradingMode.AUTOGRADED) ??
        existing.find((a) => a.gradingMode === GradingMode.AUTOGRADED) ??
        null;
      let agTemplateDueAt: Date | null = null;
      if (agTemplate?.finalGradingRunId) {
        const job = await fastify.prismaClient.job
          .findUnique({
            where: { id: agTemplate.finalGradingRunId },
            select: { dueAt: true },
          })
          .catch((e) => {
            request.log.error(e);
            throw new DatabaseFetchError({
              message: "Failed to fetch the project's final grading run.",
            });
          });
        agTemplateDueAt = job?.dueAt ?? null;
      }

      // --- apply in one transaction ---
      try {
        await fastify.prismaClient.$transaction(async (tx) => {
          for (const a of removed) {
            await deleteAssignmentInTransaction({
              tx,
              courseId,
              assignmentId: a.id,
              logger: request.log,
            });
          }
          for (const c of additionsWithIds) {
            const name = `${projectKey}: ${c.trimmedName}`;
            if (c.gradingMode === "AUTOGRADED") {
              // Inherit the sibling AG due date; if it has already passed,
              // fall back to a two-week window so the new final grading run
              // doesn't fire immediately.
              const now = new Date();
              const dueAt =
                agTemplateDueAt && agTemplateDueAt > now
                  ? agTemplateDueAt
                  : new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
              await createAssignmentWithFinalGradingJob({
                tx,
                courseId,
                assignmentId: c.id,
                name,
                dueAt,
                visibility: agTemplate?.visibility ?? AssignmentVisibility.DEFAULT,
                quotaAmount: agTemplate?.quotaAmount ?? 3,
                quotaPeriod: agTemplate?.quotaPeriod ?? AssignmentQuota.TOTAL,
                openAt: agTemplate?.openAt ?? now,
                category: Category.PROJECT,
                studentExtendable: false,
                partnerRoundNumber:
                  agTemplate?.partnerRoundNumber ?? existing[0].partnerRoundNumber,
                projectKey,
              });
            } else {
              await tx.assignment.create({
                data: {
                  courseId,
                  id: c.id,
                  name,
                  category: Category.PROJECT,
                  visibility:
                    agTemplate?.visibility ?? AssignmentVisibility.DEFAULT,
                  projectKey,
                  gradingMode: GradingMode.MANUAL,
                  weight: c.weight,
                  quotaAmount: 0,
                  quotaPeriod: AssignmentQuota.TOTAL,
                  studentExtendable: false,
                  openAt: agTemplate?.openAt ?? new Date(),
                  partnerRoundNumber:
                    existing[0].partnerRoundNumber ?? null,
                },
              });
            }
          }
          for (const c of components) {
            if (!c.assignmentId) continue;
            await tx.assignment.update({
              where: { courseId_id: { courseId, id: c.assignmentId } },
              data: { weight: c.weight },
            });
          }
        });
      } catch (e) {
        if (e instanceof BaseError) {
          throw e;
        }
        request.log.error(e);
        throw new DatabaseInsertError({
          message: "Failed to update project components.",
        });
      }

      await fastify.scheduler.refreshJobs();
      return reply.status(200).send();
    },
  );
};

export default projectGradesRoutes;
