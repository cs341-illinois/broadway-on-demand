import { FastifyPluginAsync } from "fastify";
import { FastifyZodOpenApiTypeProvider } from "fastify-zod-openapi";
import { z } from "zod";
import { Prisma, Role } from "../generated/prisma/client.js";
import {
  BaseError,
  DatabaseFetchError,
  DatabaseInsertError,
  NotFoundError,
  ValidationError,
} from "../errors/index.js";
import {
  checkInAcceptedResponse,
  courseLabsInfoResponse,
  staffWeekAttendanceResponse,
} from "../types/attendance.js";
import { netIdSchema, uinSchema } from "../types/index.js";
import { updateStudentGradesToGithub } from "../functions/github.js";
import {
  AssignmentQuota,
  AssignmentVisibility,
  Category,
} from "../generated/prisma/enums.js";

const attendanceRoutes: FastifyPluginAsync = async (fastify, _options) => {
  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().get(
    "/:courseId",
    {
      schema: {
        params: z.object({
          courseId: z.string().min(1),
        }),
        response: {
          200: courseLabsInfoResponse,
        },
      },
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.STAFF,
          Role.ADMIN,
        ]);
      },
    },
    async (request, reply) => {
      const { courseId } = request.params;
      const { firstLabDate, courseTimezone, courseCutoff } =
        await fastify.prismaClient.course
          .findFirstOrThrow({
            where: { id: courseId },
            select: {
              firstLabDate: true,
              courseTimezone: true,
              courseCutoff: true,
            },
          })
          .catch((e) => {
            throw new NotFoundError({ endpointName: request.url });
          });
      return reply.status(200).send({
        firstLabDate: firstLabDate.toISOString(),
        courseTimezone,
        courseCutoff: courseCutoff.toISOString(),
      });
    },
  );
  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().get(
    "/:courseId/week/:weekId/me",
    {
      schema: {
        params: z.object({
          courseId: z.string().min(1),
          weekId: z.coerce.number().min(0),
        }),
        response: { 200: staffWeekAttendanceResponse },
      },
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.STAFF,
          Role.ADMIN,
        ]);
      },
    },
    async (request, reply) => {
      const { courseId, weekId } = request.params;
      const netId = request.session.user.email.replace("@illinois.edu", "");
      const records = await fastify.prismaClient.attendanceRecord
        .findMany({
          where: {
            courseId,
            weekId,
            createdBy: netId,
          },
          select: {
            netId: true,
            submitted: true,
            Users: {
              select: {
                name: true,
              },
            },
            updatedAt: true,
          },
          orderBy: {
            updatedAt: "desc",
          },
        })
        .catch((e) => {
          request.log.error(e);
          throw new DatabaseFetchError({
            message: "Failed to get attendance records.",
          });
        });
      const mapped = records.map((x) => ({
        netId: x.netId,
        submitted: x.submitted,
        name: x.Users.name || x.netId,
      }));
      return reply.status(200).send(mapped);
    },
  );
  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().post(
    "/:courseId/week/:weekId/checkIn",
    {
      schema: {
        params: z.object({
          courseId: z.string().min(1),
          weekId: z.coerce.number().min(0),
        }),
        body: z.discriminatedUnion("type", [
          z.object({
            type: z.literal("uin"),
            value: uinSchema,
          }),
          z.object({
            type: z.literal("netId"),
            value: netIdSchema,
          }),
        ]),
        response: { 201: checkInAcceptedResponse },
      },
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.STAFF,
          Role.ADMIN,
        ]);
      },
    },
    async (request, reply) => {
      const { courseId, weekId } = request.params;
      let { type: idType, value } = request.body;
      const createdBy = request.session.user.email.replace("@illinois.edu", "");
      const whereClause = idType === "uin" ? { uin: value } : { netId: value };
      const { netId, name } = await fastify.prismaClient.users
        .findFirstOrThrow({
          where: { enabled: true, courseId, ...whereClause },
          select: { netId: true, name: true },
        })
        .catch((e) => {
          if (
            e instanceof Prisma.PrismaClientKnownRequestError &&
            e.code === "P2025"
          ) {
            throw new ValidationError({ message: "Not a valid user." });
          } else {
            request.log.error(e);
            throw new DatabaseFetchError({
              message: "Error occurred when mapping user.",
            });
          }
        });
      const updatedAt = new Date().toISOString();
      const result = await fastify.prismaClient.attendanceRecord.upsert({
        where: {
          courseId_weekId_netId: { courseId, weekId, netId },
          Users: { courseId, netId, enabled: true },
        },
        update: {},
        create: {
          courseId,
          weekId,
          netId,
          createdBy,
          submitted: false,
          updatedAt,
        },
      });
      const modified =
        !result.submitted && updatedAt === result.updatedAt.toISOString();
      return reply.status(201).send({
        modified,
        name: name || netId,
        netId,
      });
    },
  );
  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().post(
    "/:courseId/week/:weekId/submit",
    {
      schema: {
        params: z.object({
          courseId: z.string().min(1),
          weekId: z.coerce.number().min(0),
        }),
        response: { 201: z.null() },
      },
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.STAFF,
          Role.ADMIN,
        ]);
      },
    },
    async (request, reply) => {
      const { courseId, weekId } = request.params;
      const createdBy = request.session.user.email.replace("@illinois.edu", "");
      const assignmentId = `week${weekId + 1}_attendance`;
      await fastify.prismaClient
        .$transaction(async (tx) => {
          const gradeData = (
            await tx.attendanceRecord
              .updateManyAndReturn({
                where: { courseId, weekId, submitted: false, createdBy },
                select: { netId: true },
                data: {
                  submitted: true,
                },
              })
              .catch((e) => {
                request.log.error(e);
                throw new DatabaseFetchError({
                  message: "Could not find non-submitted records for user",
                });
              })
          ).map((x) => ({ netId: x.netId, score: 100 }));
          const { githubOrg, gradesRepo, githubToken } = await tx.course
            .findFirstOrThrow({
              where: { id: courseId },
            })
            .catch((e) => {
              throw new NotFoundError({
                endpointName: request.url,
              });
            });
          await tx.assignment.upsert({
            where: {
              courseId_id: { courseId, id: assignmentId },
            },
            update: {},
            create: {
              courseId,
              id: assignmentId,
              name: `Week ${weekId + 1} Attendance`,
              visibility: AssignmentVisibility.DEFAULT,
              category: Category.ATTENDANCE,
              quotaAmount: 0,
              quotaPeriod: AssignmentQuota.TOTAL,
              studentExtendable: false,
              openAt: new Date(),
            },
          });
          await tx.publishedGrades
            .createMany({
              data: gradeData.map((x) => ({
                courseId,
                assignmentId,
                netId: x.netId,
                score: x.score,
              })),
            })
            .catch((e) => {
              request.log.error(e);
              throw new DatabaseInsertError({
                message: "Failed to create published grades entry.",
              });
            });
          const { redisClient } = fastify;
          await updateStudentGradesToGithub({
            redisClient,
            assignmentId,
            gradeData,
            commitMessage: `Submit data for ${assignmentId} by ${createdBy}\n\nRequest ID ${request.id}`,
            githubToken,
            orgName: githubOrg,
            repoName: gradesRepo,
            logger: request.log,
          });
        })
        .catch((e) => {
          if (e instanceof BaseError) {
            throw e;
          }
          request.log.error(e);
          throw new DatabaseInsertError({
            message: "Failed to submit attendance records.",
          });
        });
    },
  );
};

export default attendanceRoutes;
