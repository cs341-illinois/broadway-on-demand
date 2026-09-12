import { FastifyPluginAsync } from "fastify";
import { Category, JobType, Prisma, Role } from "../generated/prisma/client.js";
import { getGroupForStudent } from "../functions/partners.js";
import { z } from "zod";
import {
  createAssignment,
  deleteAssignment,
  getAssignmentDueDate,
  getGradingEligibility,
  getVisibleAssignments,
  modifyAssignment,
} from "../functions/assignment.js";
import { FastifyZodOpenApiTypeProvider } from "fastify-zod-openapi";
import {
  assignmentGradesResponse,
  assignmentResponseBody,
  assignmentsResponseEntry,
  courseResponseBody,
  createAssignmentBodySchema,
  createManualAssignmentBodySchema,
  getAssignmentRuns,
  GetGradingEligibilityOutput,
  updateAssignmentBodySchema,
} from "../types/assignment.js";
import {
  AssignmentQuota,
  AssignmentVisibility,
} from "../generated/prisma/client.js";
import {
  BaseError,
  DatabaseDeleteError,
  DatabaseFetchError,
  DatabaseInsertError,
  GradingError,
  InternalServerError,
  NotFoundError,
  ValidationError,
} from "../errors/index.js";
import { getCourseRoles } from "../functions/userData.js";
import { startGradingRun } from "../functions/gradeAssignment.js";
import {
  getLatestCommit,
  updateStudentGradesToGithub,
} from "../functions/github.js";
import { netIdSchema } from "../types/index.js";
import { getGradingRunLog } from "../functions/jenkins.js";
import { PrismaClientKnownRequestError } from "../generated/prisma/internal/prismaNamespace.js";
import { assignmentGradeUploadbody } from "../types/grades.js";

const courseRoutes: FastifyPluginAsync = async (fastify, _options) => {
  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().get(
    "/:courseId",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.STAFF,
          Role.ADMIN,
          Role.STUDENT,
        ]);
      },
      schema: {
        params: z.object({ courseId: z.string().min(1) }),
        response: {
          200: courseResponseBody,
        },
      },
    },
    async (request, reply) => {
      const { courseId } = request.params;
      const { prismaClient } = fastify;
      const { name } = await fastify.prismaClient.course.findFirstOrThrow({
        where: { id: courseId },
        select: { name: true },
      });
      const courseRoles = getCourseRoles(courseId, request.session.user.roles);
      const showInvisible =
        courseRoles.includes(Role.ADMIN) || courseRoles.includes(Role.STAFF);
      const filteredAssignments = await getVisibleAssignments({
        courseId,
        prismaClient,
        showInvisible,
      });
      reply.send({ name, assignments: filteredAssignments });
    },
  );
  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().post(
    "/:courseId/assignment",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.ADMIN,
        ]);
      },
      schema: {
        body: createAssignmentBodySchema,
        params: z.object({ courseId: z.string().min(1) }),
      },
    },
    async (request, reply) => {
      const { courseId } = request.params;
      const {
        name,
        id,
        visibility,
        quotaPeriod,
        quotaAmount,
        openAt,
        dueAt,
        category,
        studentExtendable,
        partnerRoundNumber,
        projectKey,
      } = request.body;
      try {
        await createAssignment({
          client: fastify.prismaClient,
          courseId,
          assignmentId: id,
          name,
          visibility,
          quotaAmount,
          quotaPeriod,
          openAt: new Date(openAt),
          dueAt: new Date(dueAt),
          category,
          studentExtendable,
          partnerRoundNumber,
          projectKey,
        });
        reply.status(201).send();
      } catch (e) {
        if (e instanceof BaseError) {
          throw e;
        }
        fastify.log.error(e);
        throw new DatabaseInsertError({
          message: "Could not create assignment.",
        });
      }
    },
  );
  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().post(
    "/:courseId/assignment/manual",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.ADMIN,
        ]);
      },
      schema: {
        body: createManualAssignmentBodySchema,
        params: z.object({ courseId: z.string().min(1) }),
      },
    },
    async (request, reply) => {
      const { courseId } = request.params;
      const { name, id, visibility, category, projectKey, gradingMode, weight } = request.body;
      try {
        await fastify.prismaClient.assignment.create({
          data: {
            courseId,
            id,
            name,
            category,
            visibility,
            projectKey,
            gradingMode: gradingMode || "MANUAL",
            weight: weight ?? 0,
            quotaAmount: 0,
            quotaPeriod: AssignmentQuota.TOTAL,
            studentExtendable: false,
            openAt: new Date(),
          },
        });
        reply.status(201).send();
      } catch (e) {
        if (e instanceof BaseError) {
          throw e;
        }
        fastify.log.error(e);
        throw new DatabaseInsertError({
          message: "Could not create assignment.",
        });
      }
    },
  );
  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().get(
    "/:courseId/assignment/:assignmentId",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.STAFF,
          Role.ADMIN,
          Role.STUDENT,
        ]);
      },
      schema: {
        params: z.object({
          courseId: z.string().min(1),
          assignmentId: z.string().min(1),
        }),
        response: {
          200: assignmentResponseBody,
        },
      },
    },
    async (request, reply) => {
      const netId = request.session.user.email.replace("@illinois.edu", "");
      const { courseId, assignmentId } = request.params;
      const courseRoles = getCourseRoles(courseId, request.session.user.roles);
      const showInvisible =
        courseRoles.includes(Role.ADMIN) || courseRoles.includes(Role.STAFF);
      const { prismaClient } = fastify;
      const filteredAssignments = await getVisibleAssignments({
        courseId,
        prismaClient,
        showInvisible,
      });
      const targetAssignment = filteredAssignments.find(
        (x) => x.id == assignmentId,
      );
      if (!targetAssignment) {
        throw new NotFoundError({ endpointName: request.url });
      }
      const {
        name: courseName,
        githubOrg,
        githubRepoPrefix,
        feedbackBranchName,
        courseTimezone,
        githubToken,
      } = await fastify.prismaClient.course.findFirstOrThrow({
        where: { id: courseId },
        select: {
          name: true,
          githubOrg: true,
          githubRepoPrefix: true,
          feedbackBranchName: true,
          courseTimezone: true,
          githubToken: true,
        },
      });
      let repoName = `${githubRepoPrefix}_${netId}`;
      let projectRepo:
        | { repoName: string; repoUrl: string; accessPending: boolean }
        | null
        | undefined = undefined;
      if (
        targetAssignment.category === Category.PROJECT &&
        targetAssignment.projectKey != null
      ) {
        const projectRepoAssignment =
          await fastify.prismaClient.projectRepoAssignment.findFirst({
            where: {
              courseId,
              projectKey: targetAssignment.projectKey,
              netId,
              releasedAt: null,
            },
            select: { repoName: true, githubAccessConfirmed: true },
          });
        if (projectRepoAssignment) {
          repoName = projectRepoAssignment.repoName;
          projectRepo = {
            repoName: projectRepoAssignment.repoName,
            repoUrl: `https://github.com/${githubOrg}/${projectRepoAssignment.repoName}`,
            accessPending: !projectRepoAssignment.githubAccessConfirmed,
          };
        } else {
          projectRepo = null;
        }
      }
      const previousRepoAssignments =
        await fastify.prismaClient.projectRepoAssignment.findMany({
          where: {
            courseId,
            netId,
            releasedAt: { not: null },
          },
          select: {
            repoName: true,
            githubAccessConfirmed: true,
            projectKey: true,
            releasedAt: true,
          },
          orderBy: { releasedAt: "desc" },
        });
      const previousProjectRepos = previousRepoAssignments.map((r) => ({
        repoName: r.repoName,
        repoUrl: `https://github.com/${githubOrg}/${r.repoName}`,
        accessPending: !r.githubAccessConfirmed,
        projectKey: r.projectKey,
      }));
      let latestCommit: Promise<{
        sha: string;
        message: string;
        url: string;
        date?: string;
      } | null>;
      if (projectRepo === null) {
        latestCommit = Promise.resolve(null);
      } else {
        latestCommit = getLatestCommit({
          githubToken,
          orgName: githubOrg,
          repoName,
          logger: request.log,
        });
      }

      const { jenkinsPipelineName } = await fastify.prismaClient.assignment.findFirstOrThrow({
        where: { courseId, id: assignmentId },
        select: { jenkinsPipelineName: true },
      });

      const feedbackFolderName = jenkinsPipelineName || assignmentId;
      const feedbackBaseUrl = `https://github.com/${githubOrg}/${repoName}/tree/${feedbackBranchName}/${feedbackFolderName}`;
      const { name: assignmentName, openAt } = targetAssignment;
      const isStaff =
        courseRoles.includes(Role.ADMIN) || courseRoles.includes(Role.STAFF);
      const dueAt = targetAssignment.dueAt;
      const studentRuns = fastify.prismaClient.job.findMany({
        where: {
          netId: { has: netId },
          courseId,
          assignmentId,
          type: JobType.STUDENT_INITIATED,
        },
        select: {
          status: true,
          id: true,
          scheduledAt: true,
          dueAt: true,
        },
        orderBy: {
          scheduledAt: "desc",
        },
      });
      let gradingEligibility: GetGradingEligibilityOutput;
      if (isStaff) {
        gradingEligibility = {
          eligible: true,
          source: { type: "STAFF" },
          numRunsRemaining: "infinity",
          runsRemainingPeriod: AssignmentQuota.DAILY,
        };
      } else {
        gradingEligibility = await getGradingEligibility({
          tx: fastify.prismaClient,
          courseId,
          assignmentId,
          netId,
          courseTimezone,
        }).catch((e) => {
          if (e instanceof BaseError) {
            throw e;
          }
          fastify.log.error(e);
          throw new DatabaseFetchError({
            message: "Could not get grading eligibility.",
          });
        });
      }
      let partners: {
        labSection: string | null;
        roundNumber: number;
        group: {
          id: string;
          members: { netId: string; name: string | null }[];
        } | null;
      } | null = null;
      const partnerRoundNumber = targetAssignment.partnerRoundNumber;
      if ((targetAssignment.category === Category.LAB || targetAssignment.category === Category.PROJECT) && partnerRoundNumber != null) {
        const [userRow, group] = await Promise.all([
          fastify.prismaClient.users.findUnique({
            where: { netId_courseId: { netId, courseId } },
            select: { labSection: true },
          }),
          getGroupForStudent({
            tx: fastify.prismaClient,
            courseId,
            netId,
            roundNumber: partnerRoundNumber,
          }),
        ]);
        partners = {
          labSection: userRow?.labSection ?? null,
          roundNumber: partnerRoundNumber,
          group: group
            ? {
                id: group.id,
                members: group.members.map((m) => ({
                  netId: m.netId,
                  name: m.Users.name,
                })),
              }
            : null,
        };
      }

      reply.send({
        isStaff,
        feedbackBaseUrl,
        courseName,
        courseTimezone,
        assignmentName,
        openAt: new Date(openAt).toISOString(),
        dueAt: new Date(dueAt).toISOString(),
        studentRuns: (await studentRuns)
          .filter((x) => !!x.scheduledAt)
          .map((x) => ({
            ...x,
            dueAt: x.dueAt.toISOString(),
            scheduledAt: x.scheduledAt!.toISOString(),
          })),
        gradingEligibility,
        latestCommit: await latestCommit,
        projectRepo,
        previousProjectRepos,
        partners,
      });
    },
  );
  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().get(
    "/:courseId/assignment/:assignmentId/grades",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.ADMIN,
        ]);
      },
      schema: {
        params: z.object({
          courseId: z.string().min(1),
          assignmentId: z.string().min(1),
        }),
        response: {
          200: assignmentGradesResponse,
        },
      },
    },
    async (request, reply) => {
      const { courseId, assignmentId } = request.params;
      const courseExists = await fastify.prismaClient.course.count({
        where: {
          id: courseId,
        },
      });
      if (courseExists === 0) {
        throw new NotFoundError({ endpointName: request.url });
      }
      const { name: assignmentName } = await fastify.prismaClient.assignment
        .findFirstOrThrow({
          where: {
            courseId,
            id: assignmentId,
          },
          select: {
            name: true,
          },
        })
        .catch((e) => {
          if (
            e instanceof PrismaClientKnownRequestError &&
            e.code === "P2025"
          ) {
            throw new NotFoundError({ endpointName: request.url });
          }
          fastify.log.error(e);
          throw new DatabaseFetchError({
            message: "Failed to get assignment.",
          });
        });
      const publishedGrades = (
        await fastify.prismaClient.publishedGrades
          .findMany({
            where: {
              courseId,
              assignmentId,
            },
            select: {
              netId: true,
              score: true,
              comments: true,
              createdAt: true,
              updatedAt: true,
            },
          })
          .catch((e) => {
            request.log.error(e);
            throw new DatabaseFetchError({
              message: "Failed to get published grades.",
            });
          })
      ).map((x) => ({
        ...x,
        createdAt: x.createdAt.toISOString(),
        updatedAt: x.updatedAt.toISOString(),
      }));
      const nonPublishedStudents = await fastify.prismaClient.users
        .findMany({
          where: {
            courseId,
            role: Role.STUDENT,
            netId: { notIn: publishedGrades.map((x) => x.netId) },
            enabled: true,
          },
          select: {
            netId: true,
          },
        })
        .catch((e) => {
          request.log.error(e);
          throw new DatabaseFetchError({
            message: "Failed to get course roster.",
          });
        });
      const baselineScores = nonPublishedStudents.map((x) => ({
        netId: x.netId,
        score: 0,
        comments: "No score published.",
      }));
      const grades = [...publishedGrades, ...baselineScores];
      const response = {
        assignmentName,
        grades,
      };
      await reply.send(response);
    },
  );
  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().post(
    "/:courseId/assignment/:assignmentId/grades",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.ADMIN,
        ]);
      },
      schema: {
        params: z.object({
          courseId: z.string().min(1),
          assignmentId: z.string().min(1),
        }),
        body: assignmentGradeUploadbody,
        response: {
          201: z.null(),
        },
      },
    },
    async (request, reply) => {
      const requestorNetId = request.session.user!.email.replace(
        "@illinois.edu",
        "",
      );
      let body = request.body;
      const { courseId, assignmentId } = request.params;
      const courseData = await fastify.prismaClient.course.findFirst({
        where: {
          id: courseId,
        },
        select: {
          githubOrg: true,
          githubToken: true,
          gradesRepo: true,
        },
      });
      const courseRoster = await fastify.prismaClient.users
        .findMany({
          select: {
            netId: true,
          },
          where: {
            courseId,
            enabled: true,
          },
        })
        .catch((e) => {
          request.log.error(e);
          throw new DatabaseFetchError({
            message: "Could not get course roster.",
          });
        });
      const courseNetIds = new Set(courseRoster.map((x) => x.netId));
      // Only publish records that are in the roster.
      body = body.filter((x) => courseNetIds.has(x.netId));
      if (!courseData) {
        throw new NotFoundError({ endpointName: request.url });
      }
      await fastify.prismaClient
        .$transaction(async (tx) => {
          await tx.publishedGrades.deleteMany({
            where: { courseId, assignmentId },
          });
          await tx.publishedGrades.createMany({
            data: body.map((x) => ({ ...x, courseId, assignmentId })),
          });
          const cacheKey = `stats:${courseId}:${assignmentId}`;
          await fastify.redisClient.del(cacheKey);

          const { redisClient, log: logger } = fastify;
          await updateStudentGradesToGithub({
            redisClient,
            assignmentId,
            gradeData: body.map((x) => ({ ...x, comments: x.comments || "" })),
            logger,
            commitMessage: `Grade Upload for assignment ${assignmentId} by ${requestorNetId}\n\nRequest ID: ${request.id}`,
            orgName: courseData.githubOrg,
            repoName: courseData.gradesRepo,
            githubToken: courseData.githubToken,
            overwrite: true,
          });
        })
        .catch((e) => {
          fastify.log.error(e);
          throw new DatabaseInsertError({
            message: "Failed to set assignment grades.",
          });
        });
      reply.status(201).send();
    },
  );
  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().get(
    "/:courseId/assignment/:assignmentId/raw",
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
        }),
        response: {
          200: assignmentsResponseEntry.extend({
            jenkinsPipelineName: z.string().optional(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { courseId, assignmentId } = request.params;
      const data = await fastify.prismaClient
        .$transaction(async (tx) => {
          const interim = await tx.assignment
            .findFirstOrThrow({
              where: {
                courseId,
                id: assignmentId,
              },
            })
            .catch((e) => {
              fastify.log.error(e);
              throw new DatabaseFetchError({
                message: "Could not retrieve assignment data. ",
              });
            });
          const dueAt = await getAssignmentDueDate({
            tx,
            courseId,
            assignmentId,
          });
          if (!dueAt) {
            throw new DatabaseFetchError({
              message: "Could not find due time.",
            });
          }
          return {
            ...interim,
            studentExtendable: interim.studentExtendable,
            openAt: interim.openAt.toISOString(),
            dueAt: dueAt.toISOString(),
          };
        })
        .catch((e) => {
          if (e instanceof BaseError) {
            throw e;
          }
          fastify.log.error(e);
          throw new DatabaseFetchError({
            message: "Could not retrieve full assignment data.",
          });
        });
      return reply.send({
        ...data,
        jenkinsPipelineName: data.jenkinsPipelineName || undefined,
      });
    },
  );
  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().patch(
    "/:courseId/assignment/:assignmentId",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.ADMIN,
        ]);
      },
      schema: {
        params: z.object({
          courseId: z.string().min(1),
          assignmentId: z.string().min(1),
        }),
        response: {
          200: z.null(),
        },
        body: updateAssignmentBodySchema,
      },
    },
    async (request, reply) => {
      const { courseId, assignmentId } = request.params;
      await modifyAssignment({
        client: fastify.prismaClient,
        courseId,
        assignmentId,
        ...request.body,
        dueAt: new Date(request.body.dueAt),
        openAt: new Date(request.body.openAt),
      }).catch((e) => {
        if (e instanceof BaseError) {
          throw e;
        }
        fastify.log.error(e);
        throw new DatabaseInsertError({
          message: "Failed to update assignment.",
        });
      });
      await fastify.scheduler.refreshJobs();
      return reply.status(201).send();
    },
  );
  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().delete(
    "/:courseId/assignment/:assignmentId",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.ADMIN,
        ]);
      },
      schema: {
        params: z.object({
          courseId: z.string().min(1),
          assignmentId: z.string().min(1),
        }),
        response: {
          201: z.null(),
        },
        body: z.null(),
      },
    },
    async (request, reply) => {
      const { courseId, assignmentId } = request.params;
      await deleteAssignment({
        client: fastify.prismaClient,
        courseId,
        assignmentId,
        scheduler: fastify.scheduler,
        logger: fastify.log,
      }).catch((e) => {
        if (e instanceof BaseError) {
          throw e;
        }
        fastify.log.error(e);
        throw new DatabaseDeleteError({
          message: "Failed to delete assignment.",
        });
      });
      return reply.status(201).send();
    },
  );
  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().post(
    "/:courseId/assignment/:assignmentId/grade",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.STAFF,
          Role.ADMIN,
          Role.STUDENT,
        ]);
      },
      schema: {
        params: z.object({
          courseId: z.string().min(1),
          assignmentId: z.string().min(1),
        }),
        body: z.object({
          expectedCommitHash: z.string().min(1),
        }),
        response: {
          201: z.null(),
        },
      },
    },
    async (request, reply) => {
      const netId = request.session.user.email.replace("@illinois.edu", "");
      const { courseId, assignmentId } = request.params;
      let { expectedCommitHash } = request.body;
      const courseRoles = getCourseRoles(courseId, request.session.user.roles);
      const {
        jenkinsBaseUrl,
        jenkinsToken,
        courseTimezone,
        githubOrg,
        githubToken,
      } = await fastify.prismaClient.course.findFirstOrThrow({
        where: { id: courseId },
        select: {
          courseTimezone: true,
          jenkinsBaseUrl: true,
          jenkinsToken: true,
          githubOrg: true,
          githubToken: true,
        },
      });
      const assignmentRow =
        await fastify.prismaClient.assignment.findFirstOrThrow({
          where: { id: assignmentId, courseId },
          select: {
            jenkinsPipelineName: true,
            category: true,
            projectKey: true,
          },
        });
      let jenkinsPipelineName = assignmentRow.jenkinsPipelineName || assignmentId;

      let projectGradeLockTs: number | null = null;
      let projectGradeLockKey: string | null = null;
      let projectGradeLockAcquired = false;
      let projectRepoName: string | null = null;
      if (
        assignmentRow.category === Category.PROJECT &&
        assignmentRow.projectKey != null
      ) {
        const projectRepoAssignment =
          await fastify.prismaClient.projectRepoAssignment.findFirst({
            where: {
              courseId,
              projectKey: assignmentRow.projectKey,
              netId,
              releasedAt: null,
            },
            select: { repoName: true },
          });
        if (!projectRepoAssignment) {
          throw new ValidationError({ message: "No project repo assigned" });
        }
        projectRepoName = projectRepoAssignment.repoName;
        projectGradeLockKey = `projectrepo:grade:${courseId}:${projectRepoAssignment.repoName}`;
        projectGradeLockTs = new Date().getTime();
        const lockResponse = await fastify.redisClient.set(
          projectGradeLockKey,
          projectGradeLockTs,
          { NX: true, PX: 30000 },
        );
        if (!lockResponse) {
          throw new ValidationError({
            message:
              "Another member of your group is currently running grading. Please wait and try again.",
          });
        }
        projectGradeLockAcquired = true;
        const serverCommit = await getLatestCommit({
          githubToken,
          orgName: githubOrg,
          repoName: projectRepoAssignment.repoName,
          logger: fastify.log,
        });
        if (!serverCommit) {
          throw new ValidationError({
            message:
              "Could not resolve the latest commit for your project repo. Please ensure your repository has at least one commit and try again.",
          });
        }
        expectedCommitHash = serverCommit.sha;
      }

      try {
        const isStaff =
          courseRoles.includes(Role.ADMIN) || courseRoles.includes(Role.STAFF);
        if (isStaff) {
          await fastify.prismaClient
            .$transaction(async (tx) => {
              const result = await tx.job.create({
                data: {
                  name: JobType.STUDENT_INITIATED,
                  courseId,
                  assignmentId,
                  netId: [netId],
                  type: JobType.STUDENT_INITIATED,
                  dueAt: new Date().toISOString(),
                  scheduledAt: new Date().toISOString(),
                },
                select: {
                  id: true,
                },
              });
              const queueUrl = await startGradingRun({
                courseId,
                jenkinsPipelineName,
                netIds: [netId],
                isoTimestamp: "now",
                jenkinsBaseUrl,
                courseTimezone,
                jenkinsToken,
                type: JobType.STUDENT_INITIATED,
                gradingRunId: result.id,
                expectedCommitHash,
                repoMap: projectRepoName ? { [netId]: projectRepoName } : undefined,
                logger: fastify.log,
              });
              if (queueUrl) {
                await tx.job.update({
                  where: { id: result.id },
                  data: { queueUrl }
                })
              } else {
                request.log.error(`Could not find queue URL for job ${result.id}!`)
              }

              return result;
            })
            .catch((e) => {
              if (e instanceof BaseError) {
                throw e;
              }
              fastify.log.error(e);
              throw new GradingError({
                message: "Could not start grading job.",
              });
            });
        } else {
          // Get grading eligibility;
          await fastify.prismaClient
            .$transaction(
              async (tx) => {
                const gradingEligibility = await getGradingEligibility({
                  tx,
                  courseId,
                  netId,
                  assignmentId,
                  courseTimezone,
                });
                if (!gradingEligibility.eligible) {
                  throw new ValidationError({
                    message: "User is not eligible for a grading run.",
                  });
                }
                if (gradingEligibility.source.type === "EXTENSION") {
                  const extensionId = gradingEligibility.source.extensionid;
                  await tx.extensionUsageHistory.create({
                    data: {
                      courseId,
                      assignmentId,
                      netId,
                      extensionId,
                    },
                  });
                }
                let { jenkinsPipelineName } =
                  await tx.assignment.findFirstOrThrow({
                    where: { id: assignmentId, courseId },
                    select: {
                      jenkinsPipelineName: true,
                    },
                  });
                jenkinsPipelineName = jenkinsPipelineName || assignmentId;
                const result = await tx.job.create({
                  data: {
                    name: JobType.STUDENT_INITIATED,
                    courseId,
                    assignmentId,
                    netId: [netId],
                    type: JobType.STUDENT_INITIATED,
                    dueAt: new Date().toISOString(),
                    scheduledAt: new Date().toISOString(),
                  },
                  select: {
                    id: true,
                  },
                });
                const queueUrl = await startGradingRun({
                  courseId,
                  jenkinsPipelineName,
                  netIds: [netId],
                  isoTimestamp: "now",
                  jenkinsBaseUrl,
                  courseTimezone,
                  jenkinsToken,
                  type: JobType.STUDENT_INITIATED,
                  gradingRunId: result.id,
                  expectedCommitHash,
                  repoMap: projectRepoName ? { [netId]: projectRepoName } : undefined,
                  logger: fastify.log,
                });
                if (queueUrl) {
                  await tx.job.update({
                    where: { id: result.id },
                    data: { queueUrl }
                  })
                } else {
                  request.log.error(`Could not find queue URL for job ${result.id}!`)
                }
                return result;
              },
              { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
            )
            .catch((e) => {
              if (e instanceof BaseError) {
                throw e;
              }
              fastify.log.error(e);
              throw new GradingError({
                message: "Could not start grading run.",
              });
            });
        }
      } finally {
        if (
          projectGradeLockAcquired &&
          projectGradeLockKey &&
          projectGradeLockTs != null
        ) {
          const lockValue = await fastify.redisClient.get(projectGradeLockKey);
          if (lockValue) {
            const retrievedLockTs = parseInt(lockValue, 10);
            if (projectGradeLockTs === retrievedLockTs) {
              await fastify.redisClient.del(projectGradeLockKey);
            }
          }
        }
      }
      return reply.status(201).send();
    },
  );
  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().get(
    "/:courseId/assignment/:assignmentId/runs",
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
        }),
        response: {
          200: getAssignmentRuns,
        },
      },
    },
    async (request, reply) => {
      const { courseId, assignmentId } = request.params;
      const data = await fastify.prismaClient.job
        .findMany({
          where: { courseId, assignmentId },
          select: {
            id: true,
            type: true,
            buildUrl: true,
            scheduledAt: true,
            dueAt: true,
            netId: true,
            status: true,
          },
        })
        .catch((e) => {
          if (e instanceof BaseError) {
            throw e;
          }
          fastify.log.error(e);
          throw new DatabaseFetchError({
            message: "Could not retrieve run data.",
          });
        });
      return reply.send(
        data.map((x) => ({
          ...x,
          dueAt: x.dueAt?.toISOString(),
          scheduledAt: x.scheduledAt?.toISOString(),
        })),
      );
    },
  );
  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().get(
    "/:courseId/assignment/:assignmentId/run/:runId/user/:netId/log",
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
          runId: z.string().min(1),
          netId: netIdSchema,
        }),
        response: {
          200: z.string().min(1),
        },
      },
    },
    async (request, reply) => {
      const { courseId, assignmentId, runId, netId } = request.params;
      const data = await fastify.prismaClient.job
        .findFirstOrThrow({
          where: { courseId, assignmentId, id: runId },
          select: {
            buildUrl: true,
            netId: true,
            course: {
              select: {
                jenkinsBaseUrl: true,
                jenkinsToken: true,
              },
            },
            Assignment: {
              select: {
                jenkinsPipelineName: true,
              },
            },
          },
        })
        .catch((e) => {
          if (e instanceof BaseError) {
            throw e;
          }
          fastify.log.error(e);
          throw new DatabaseFetchError({
            message: "Could not retrieve run data.",
          });
        });
      const jenkinsToken = data.course.jenkinsToken;
      const buildUrl = data.buildUrl;
      if (!buildUrl) {
        throw new NotFoundError({ endpointName: request.url });
      }
      const jenkinsPipelineName =
        data.Assignment?.jenkinsPipelineName || assignmentId;
      const jenkinsUrl = data.course.jenkinsBaseUrl;
      const log = await getGradingRunLog({
        jenkinsToken,
        jenkinsPipelineName,
        jenkinsUrl,
        buildUrl,
        netId,
        logger: request.log,
      });
      return reply.send(log);
    },
  );
};

export default courseRoutes;
