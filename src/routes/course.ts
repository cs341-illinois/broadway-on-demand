import { FastifyPluginAsync } from "fastify";
import { JobType, Prisma, Role } from "../generated/prisma/client.js";
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
      const { name, id, visibility, category } = request.body;
      try {
        await fastify.prismaClient.assignment.create({
          data: {
            courseId,
            id,
            name,
            category,
            visibility,
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
      const latestCommit = getLatestCommit({
        githubToken,
        orgName: githubOrg,
        repoName: `${githubRepoPrefix}_${netId}`,
        logger: request.log,
      });

      const feedbackBaseUrl = `https://github.com/${githubOrg}/${githubRepoPrefix}_${netId}/tree/${feedbackBranchName}/${assignmentId}`;
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
      const nonPublishedStudents = await fastify.prismaClient.users.findMany({
        where: {
          courseId,
          role: Role.STUDENT,
          netId: { notIn: publishedGrades.map(x => x.netId) },
          enabled: true
        },
        select: {
          netId: true
        }
      }).catch(e => {
        request.log.error(e);
        throw new DatabaseFetchError({ message: "Failed to get course roster." })
      });
      const baselineScores = nonPublishedStudents.map(x => ({
        netId: x.netId,
        score: 0,
        comments: "No score published."
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
      const body = request.body;
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
          const { redisClient, log: logger } = fastify;
          await updateStudentGradesToGithub({
            redisClient,
            assignmentId,
            gradeData: body,
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
          dueDate: z
            .string()
            .datetime()
            .refine((val) => new Date(val) <= new Date(), {
              message: "Due date must not be in the future.",
            }),
        }),
        response: {
          201: z.null(),
        },
      },
    },
    async (request, reply) => {
      const netId = request.session.user.email.replace("@illinois.edu", "");
      const { courseId, assignmentId } = request.params;
      const { dueDate: userDueDate } = request.body;
      const dueAtTimestamp = new Date(userDueDate).toISOString();
      const courseRoles = getCourseRoles(courseId, request.session.user.roles);
      const { jenkinsBaseUrl, jenkinsToken, courseTimezone } =
        await fastify.prismaClient.course.findFirstOrThrow({
          where: { id: courseId },
          select: {
            courseTimezone: true,
            jenkinsBaseUrl: true,
            jenkinsToken: true,
          },
        });
      let { jenkinsPipelineName } =
        await fastify.prismaClient.assignment.findFirstOrThrow({
          where: { id: assignmentId, courseId },
          select: {
            jenkinsPipelineName: true,
          },
        });
      jenkinsPipelineName = jenkinsPipelineName || assignmentId;

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
                dueAt: dueAtTimestamp,
                scheduledAt: new Date().toISOString(),
              },
              select: {
                id: true,
              },
            });
            await startGradingRun({
              courseId,
              jenkinsPipelineName,
              netIds: [netId],
              isoTimestamp: dueAtTimestamp,
              jenkinsBaseUrl,
              courseTimezone,
              jenkinsToken,
              type: JobType.STUDENT_INITIATED,
              gradingRunId: result.id,
              logger: fastify.log,
            });
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
                  dueAt: dueAtTimestamp,
                  scheduledAt: new Date().toISOString(),
                },
                select: {
                  id: true,
                },
              });
              await startGradingRun({
                courseId,
                jenkinsPipelineName,
                netIds: [netId],
                isoTimestamp: dueAtTimestamp,
                jenkinsBaseUrl,
                courseTimezone,
                jenkinsToken,
                type: JobType.STUDENT_INITIATED,
                gradingRunId: result.id,
                logger: fastify.log,
              });
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
