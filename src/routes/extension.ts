import {
  ExtensionInitiator,
  Job,
  JobType,
  Role,
} from "../generated/prisma/client.js";
import { FastifyPluginAsync } from "fastify";
import { FastifyZodOpenApiTypeProvider } from "fastify-zod-openapi";
import { z } from "zod";
import { createExtensionBody } from "../types/assignment.js";
import {
  BaseError,
  DatabaseDeleteError,
  DatabaseFetchError,
  DatabaseInsertError,
  ValidationError,
} from "../errors/index.js";
import {
  assignmentExtensionResponseSchema,
  selfExtensionsResponseSchema,
} from "../types/extension.js";
import {
  getAssignmentDueDate,
  getAutogradableAssignments,
} from "../functions/assignment.js";
import moment from "moment-timezone";
import { PrismaJobRepository } from "../scheduler/prismaRepository.js";
import { close } from "fs";

const extensionRoutes: FastifyPluginAsync = async (fastify, _options) => {
  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().get(
    "/:courseId/self",
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
        }),
        response: {
          200: selfExtensionsResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { courseId } = request.params;
      const netId = request.session.user!.email.replace("@illinois.edu", "");
      const data = await fastify.prismaClient
        .$transaction(async (tx) => {
          const {
            numExtensions,
            numExtensionHours,
            name: courseName,
            courseCutoff,
          } = await tx.course
            .findFirstOrThrow({
              where: {
                id: courseId,
              },
              select: {
                numExtensionHours: true,
                numExtensions: true,
                name: true,
                courseCutoff: true,
              },
            })
            .catch((e) => {
              fastify.log.error(e);
              throw new DatabaseFetchError({
                message: "Could not find course extensions configuration.",
              });
            });
          const userAppliedExtensions = await tx.extensions
            .findMany({
              where: {
                courseId,
                createdBy: netId,
                extensionType: ExtensionInitiator.STUDENT,
              },
              select: {
                assignmentId: true,
                openAt: true,
                closeAt: true,
                quotaAmount: true,
                quotaPeriod: true,
                Assignment: {
                  select: { name: true },
                },
              },
            })
            .catch((e) => {
              fastify.log.error(e);
              throw new DatabaseFetchError({
                message: "Could not find user extensions configuration.",
              });
            });
          const alreadyAppliedIds = userAppliedExtensions.map(
            (x) => x.assignmentId,
          );
          const numExtensionsRemaining = Math.max(
            0,
            numExtensions - userAppliedExtensions.length,
          );
          const visibleAssignmentsRaw = await getAutogradableAssignments({
            courseId,
            prismaClient: fastify.prismaClient,
            showInvisible: false,
            showUnextendable: false,
          });
          const visibleAssignments = visibleAssignmentsRaw
            .filter((x) => !alreadyAppliedIds.includes(x.id))
            .filter(
              (x) =>
                new Date(x.openAt) < new Date() &&
                new Date(x.dueAt) > new Date(),
            )
            .filter((x) => {
              return (
                moment(x.dueAt).add({ hours: numExtensionHours }).toDate() <
                courseCutoff
              );
            });
          return {
            courseName,
            courseCutoff: courseCutoff.toISOString(),
            userAppliedExtensions: userAppliedExtensions.map((x) => ({
              ...x,
              name: x.Assignment.name,
              quotaAmount: x.quotaAmount,
              quotaPeriod: x.quotaPeriod,
              openAt: x.openAt.toISOString(),
              closeAt: x.closeAt.toISOString(),
            })),
            numExtensionsRemaining,
            numExtensionHours,
            visibleAssignments,
          };
        })
        .catch((e) => {
          if (e instanceof BaseError) {
            throw e;
          }
          fastify.log.error(e);
          throw new DatabaseFetchError({
            message: "Failed to retrieve extension information.",
          });
        });
      return reply.send(data);
    },
  );
  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().post(
    "/:courseId/assignment/:assignmentId/self",
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
          201: z.null(),
        },
      },
    },
    async (request, reply) => {
      const { courseId, assignmentId } = request.params;
      const netId = request.session.user!.email.replace("@illinois.edu", "");
      let extensionId: string = "";
      await fastify.prismaClient
        .$transaction(async (tx) => {
          const {
            numExtensions,
            numExtensionHours,
            name: courseName,
            courseCutoff,
          } = await tx.course
            .findFirstOrThrow({
              where: {
                id: courseId,
              },
              select: {
                numExtensionHours: true,
                numExtensions: true,
                name: true,
                courseCutoff: true,
              },
            })
            .catch((e) => {
              fastify.log.error(e);
              throw new DatabaseFetchError({
                message: "Could not find course extensions configuration.",
              });
            });
          const userAppliedExtensions = await tx.extensions
            .findMany({
              where: {
                courseId,
                createdBy: netId,
                extensionType: ExtensionInitiator.STUDENT,
              },
              select: {
                assignmentId: true,
                openAt: true,
                closeAt: true,
                quotaAmount: true,
                quotaPeriod: true,
              },
            })
            .catch((e) => {
              fastify.log.error(e);
              throw new DatabaseFetchError({
                message: "Could not find user extensions configuration.",
              });
            });
          const numExtensionsRemaining = Math.max(
            0,
            numExtensions - userAppliedExtensions.length,
          );
          const visibleAssignmentsRaw = await getAutogradableAssignments({
            courseId,
            prismaClient: fastify.prismaClient,
            showInvisible: false,
            showUnextendable: false,
          });
          const visibleAssignments = visibleAssignmentsRaw
            .filter(
              (x) =>
                !userAppliedExtensions
                  .map((x) => x.assignmentId)
                  .includes(x.id),
            )
            .filter(
              (x) =>
                new Date(x.openAt) < new Date() &&
                new Date(x.dueAt) > new Date(),
            )
            .filter((x) => {
              return (
                moment(x.dueAt).add({ hours: numExtensionHours }).toDate() <
                courseCutoff
              );
            });
          const data = {
            courseName,
            courseCutoff: courseCutoff.toISOString(),
            userAppliedExtensions: userAppliedExtensions.map((x) => ({
              ...x,
              openAt: x.openAt.toISOString(),
              closeAt: x.closeAt.toISOString(),
            })),
            numExtensionsRemaining,
            numExtensionHours,
            visibleAssignments,
          };
          if (data.numExtensionsRemaining <= 0) {
            throw new ValidationError({
              message: "User is not eligible for any more extensions.",
            });
          }
          if (
            !data.visibleAssignments.map((x) => x.id).includes(assignmentId)
          ) {
            throw new ValidationError({
              message: "User cannot extend this assignment.",
            });
          }
          const { quotaAmount, quotaPeriod } = await tx.assignment
            .findFirstOrThrow({ where: { courseId, id: assignmentId } })
            .catch((e) => {
              throw new DatabaseFetchError({
                message: "Could not get assignment information.",
              });
            });
          const dueAt = await getAssignmentDueDate({
            tx,
            courseId,
            assignmentId,
          });
          if (!dueAt) {
            throw new DatabaseFetchError({
              message: "Could not find assignment due date.",
            });
          }
          const openAt = moment(dueAt).add({ seconds: 1 });
          const extensionDueAt = moment(dueAt).add({
            hours: numExtensionHours,
          });
          const extensionScheduledAt = moment(dueAt).add({
            hours: numExtensionHours,
            minutes: 5,
          });
          const job = await fastify.scheduler.scheduleJob(
            `${netId} Extension Grading Run`,
            {
              courseId,
              assignmentId,
              netId: [netId],
              type: JobType.FINAL_GRADING,
              dueAt: extensionDueAt.toDate(),
            },
            extensionScheduledAt.toDate(),
          );
          const extensionData = await tx.extensions
            .create({
              data: {
                courseId,
                assignmentId,
                netId,
                quotaAmount,
                quotaPeriod,
                createdBy: netId,
                openAt: openAt.toDate(),
                closeAt: extensionDueAt.toDate(),
                extensionType: ExtensionInitiator.STUDENT,
                finalGradingRunId: job.id,
              },
            })
            .catch((e) => {
              fastify.log.error(e);
              throw new DatabaseInsertError({
                message: "Failed to create extension payload.",
              });
            });
          extensionId = extensionData.id;
        })
        .catch((e) => {
          if (e instanceof BaseError) {
            throw e;
          }
          fastify.log.error(e);
          throw new DatabaseInsertError({
            message: "Failed to insert extension information.",
          });
        });
      request.log.debug(`Created extension ID ${extensionId}`);
      return reply.status(201).send();
    },
  );
  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().post(
    "/:courseId/assignment/:assignmentId/admin",
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
        body: createExtensionBody,
        response: {
          201: z.null(),
        },
      },
    },
    async (request, reply) => {
      const { courseId, assignmentId } = request.params;
      const {
        quotaAmount,
        quotaPeriod,
        openAt,
        closeAt,
        netIds: uncleanNetIds,
        createFinalGradingRun,
      } = request.body;
      const createdBy = request.session.user!.email.replace(
        "@illinois.edu",
        "",
      );
      const netIds = [...new Set(uncleanNetIds)];
      await fastify.prismaClient
        .$transaction(async (tx) => {
          // validate all NetIDs as enabled in the course.
          const count = await tx.users.count({
            where: {
              courseId,
              netId: { in: netIds },
              enabled: true,
            },
          });
          if (count !== netIds.length) {
            throw new ValidationError({
              message: "One or more users were not found in this course.",
            });
          }
          let job: Job | null;
          if (createFinalGradingRun) {
            const jobRepository = new PrismaJobRepository(tx);
            job = await jobRepository.createJob({
              type: JobType.FINAL_GRADING,
              name: "Extension Run",
              scheduledAt: moment(closeAt).add({ minutes: 5 }).toDate(),
              dueAt: new Date(closeAt),
              netId: netIds,
              courseId,
              assignmentId,
            });
          }

          await tx.extensions
            .createMany({
              data: netIds.map((netId) => ({
                courseId,
                assignmentId,
                netId,
                quotaAmount,
                quotaPeriod,
                openAt,
                closeAt,
                finalGradingRunId: job ? job.id : null,
                createdBy,
                extensionType: ExtensionInitiator.STAFF,
              })),
            })
            .catch((e) => {
              request.log.error(e);
              throw new DatabaseInsertError({
                message: "Error creating the extension.",
              });
            });
        })
        .catch((e) => {
          if (e instanceof BaseError) {
            throw e;
          }
          request.log.error(e);
          throw new DatabaseInsertError({
            message: "Could not create the extension.",
          });
        });
      if (createFinalGradingRun) {
        await fastify.scheduler.refreshJobs();
      }
      return reply.status(201).send();
    },
  );
  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().delete(
    "/:courseId/assignment/:assignmentId/id/:extensionId",
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
          extensionId: z.string().min(1),
        }),
        response: {
          201: z.null(),
        },
      },
    },
    async (request, reply) => {
      const { courseId, assignmentId, extensionId } = request.params;
      await fastify.prismaClient
        .$transaction(async (tx) => {
          const { finalGradingRunId } = await tx.extensions
            .delete({
              where: {
                courseId,
                assignmentId,
                id: extensionId,
              },
              select: {
                finalGradingRunId: true,
              },
            })
            .catch((e) => {
              fastify.log.error(e);
              throw new DatabaseDeleteError({
                message: "Failed to delete extension.",
              });
            });
          if (finalGradingRunId) {
            const jobRepository = new PrismaJobRepository(tx);
            await jobRepository.deleteJob(finalGradingRunId).catch((e) => {
              throw new DatabaseDeleteError({
                message: "Failed to remove final grading job from scheduler.",
              });
            });
          }
        })
        .catch((e) => {
          if (e instanceof BaseError) {
            throw e;
          }
          fastify.log.error(e);
          throw new DatabaseDeleteError({
            message: "Failed to delete extension.",
          });
        });

      return reply.status(201).send();
    },
  );
  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().get(
    "/:courseId/assignment/:assignmentId",
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
          200: assignmentExtensionResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { courseId, assignmentId } = request.params;
      const data = await fastify.prismaClient.extensions
        .findMany({
          where: {
            courseId,
            assignmentId,
          },
          select: {
            id: true,
            netId: true,
            openAt: true,
            closeAt: true,
            quotaAmount: true,
            quotaPeriod: true,
            extensionType: true,
            finalGradingRunId: true,
            createdBy: true,
          },
        })
        .catch((e) => {
          if (e instanceof BaseError) {
            throw e;
          }
          fastify.log.error(e);
          throw new DatabaseFetchError({
            message: "Failed to retrieve extension information.",
          });
        });
      const cleaned = data.map((x) => ({
        ...x,
        hasFinalGradingRun: Boolean(x),
        openAt: x.openAt.toISOString(),
        closeAt: x.closeAt.toISOString(),
      }));
      return reply.send(cleaned);
    },
  );
  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().post(
    "/:courseId/assignment/:assignmentId/id/:extensionId/refundStudentExtension",
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
          extensionId: z.string().min(1),
        }),
        body: z.null(),
        response: {
          201: z.null(),
        },
      },
    },
    async (request, reply) => {
      const { courseId, assignmentId, extensionId } = request.params;
      const createdBy = request.session.user!.email.replace(
        "@illinois.edu",
        "",
      );
      request.log.info({ courseId, assignmentId, extensionId }, `Extension marked as exempt from NQE cap by ${createdBy}.`)
      await fastify.prismaClient.extensions.update({
        where: {
          id: extensionId,
          extensionType: ExtensionInitiator.STUDENT
        },
        data: {
          extensionType: ExtensionInitiator.STUDENT_EXEMPT
        }
      }).catch((e) => {
        if (e instanceof BaseError) {
          throw e;
        }
        if (e.code === 'P2025') {
          request.log.warn({ extensionId }, 'Extension not found or not student-initiated, skipping update.');
          return;
        }
        fastify.log.error(e);
        throw new DatabaseInsertError({
          message: "Failed to update extension information.",
        });
      });
      return reply.status(201).send();
    },
  );
};
export default extensionRoutes;
