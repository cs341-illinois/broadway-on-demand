import { Role } from "../generated/prisma/client.js";
import { FastifyPluginAsync } from "fastify";
import { FastifyZodOpenApiTypeProvider } from "fastify-zod-openapi";
import { z } from "zod";
import {
  BaseError,
  DatabaseDeleteError,
  DatabaseFetchError,
  DatabaseInsertError,
  NotFoundError,
  ValidationError,
} from "../errors/index.js";
import {
  manageRosterRequestBodySchema,
  manageRosterSuccessResponseSchema,
  overwriteStudentRosterBodySchema,
} from "../types/roster.js";
import { overwriteRosterToGithub } from "../functions/github.js";

const rosterRoutes: FastifyPluginAsync = async (fastify, _options) => {
  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().get(
    "/:courseId/all",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.STAFF,
          Role.ADMIN,
        ]);
      },
      schema: {
        params: z.object({ courseId: z.string().min(1) }),
      },
    },
    async (request, reply) => {
      const { courseId } = request.params;
      const roster = await fastify.prismaClient.users
        .findMany({
          where: {
            courseId,
            enabled: true,
          },
          select: {
            name: true,
            netId: true,
            uin: true,
            role: true,
          },
          orderBy: {
            netId: "asc",
          },
        })
        .catch((e) => {
          fastify.log.error(e);
          throw new DatabaseFetchError({ message: "Could not get roster." });
        });
      return reply.status(200).send(roster);
    },
  );

  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().patch(
    "/:courseId/all",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.ADMIN,
        ]);
      },
      schema: {
        params: z.object({
          courseId: z.string().min(1),
        }),
        body: manageRosterRequestBodySchema,
        response: {
          200: manageRosterSuccessResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { courseId } = request.params;
      const { action, users } = request.body;
      const adminNetId = (request.session.user!.email as string).replace(
        "@illinois.edu",
        "",
      );

      const processedUsersInfo: Array<{
        netId: string;
        status: string;
        message?: string;
      }> = [];
      const { githubOrg, rosterRepo, githubToken } =
        await fastify.prismaClient.course
          .findFirstOrThrow({
            where: { id: courseId },
            select: {
              githubOrg: true,
              rosterRepo: true,
              githubToken: true,
            },
          })
          .catch((e) => {
            throw new NotFoundError({ endpointName: request.url });
          });
      let isModifyingStudent = false;
      try {
        if (action === "add") {
          await fastify.prismaClient.$transaction(async (tx) => {
            for (const user of users) {
              if (user.role === Role.STUDENT) {
                isModifyingStudent = true;
              }
              await tx.users.upsert({
                where: {
                  netId_courseId: { netId: user.netId, courseId: courseId },
                },
                update: {
                  uin: user.uin,
                  name: user.name,
                  role: user.role,
                  enabled: true,
                },
                create: {
                  netId: user.netId,
                  role: user.role,
                  courseId: courseId,
                  uin: user.uin,
                  name: user.name,
                  enabled: true,
                },
              });
              processedUsersInfo.push({
                netId: user.netId,
                status: "User processed successfully.",
              });
              fastify.log.info(
                `Admin ${adminNetId} processed add/update for user ${user.netId} (role: ${user.role}) to course ${courseId}.`,
              );
            }
          });
        } else if (action === "disable") {
          const selfDeleteAttempt = users.find(
            (user) => user.netId === adminNetId,
          );
          if (selfDeleteAttempt) {
            throw new ValidationError({
              message: `Administrators cannot disable themselves. User ${adminNetId} was part of the disable request.`,
            });
          }

          await fastify.prismaClient
            .$transaction(async (tx) => {
              for (const user of users) {
                if (user.role === Role.STUDENT) {
                  isModifyingStudent = true;
                }
                await tx.users.update({
                  where: {
                    netId_courseId: { netId: user.netId, courseId: courseId },
                  },
                  data: {
                    enabled: false,
                  },
                });
                processedUsersInfo.push({
                  netId: user.netId,
                  status: "User processed successfully.",
                });
                fastify.log.info(
                  `Admin ${adminNetId} processed disable for user ${user.netId} from course ${courseId}`,
                );
              }
            })
            .catch((e) => {
              if (e instanceof BaseError) {
                throw e;
              }
              request.log.error(e);
              throw new DatabaseInsertError({
                message: "Failed to save changes.",
              });
            });
        }
        if (isModifyingStudent) {
          const netIdsDirty = await fastify.prismaClient.users
            .findMany({
              select: { netId: true },
              where: { courseId, enabled: true, role: Role.STUDENT },
            })
            .catch((e) => {
              request.log.error(e);
              throw new DatabaseFetchError({
                message: "Failed to get new set of users.",
              });
            });
          const netIds = netIdsDirty.map((x) => x.netId).sort();
          const { redisClient } = fastify;
          const commitMessage = `Roster update by ${adminNetId}\n\nRequest ID: ${request.id}`;
          await overwriteRosterToGithub({
            redisClient,
            netIds,
            commitMessage,
            githubToken,
            orgName: githubOrg,
            repoName: rosterRepo,
            logger: request.log,
          });
        }
        return reply.status(200).send({
          operationStatus: `Roster '${action}' operation completed successfully for all users.`,
          results: processedUsersInfo,
        });
      } catch (error) {
        fastify.log.error(
          error,
          `Error during roster '${action}' operation for course ${courseId} by admin ${adminNetId}`,
        );
        if (error instanceof BaseError) {
          throw error;
        }
        throw new DatabaseInsertError({
          message:
            "An error occurred while processing the roster batch operation.",
        });
      }
    },
  );
  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().post(
    "/:courseId/students",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.ADMIN,
        ]);
      },
      schema: {
        params: z.object({
          courseId: z.string().min(1),
        }),
        body: overwriteStudentRosterBodySchema,
        response: {
          201: z.null(),
        },
      },
    },
    async (request, reply) => {
      const { courseId } = request.params;
      const adminNetId = (request.session.user!.email as string).replace(
        "@illinois.edu",
        "",
      );
      const { githubOrg, rosterRepo, githubToken } =
        await fastify.prismaClient.course
          .findFirstOrThrow({
            where: { id: courseId },
            select: {
              githubOrg: true,
              rosterRepo: true,
              githubToken: true,
            },
          })
          .catch((e) => {
            throw new NotFoundError({ endpointName: request.url });
          });
      const users = request.body;
      await fastify.prismaClient
        .$transaction(
          async (tx) => {
            await tx.users
              .updateMany({
                where: { courseId, role: Role.STUDENT },
                data: { enabled: false },
              })
              .catch((e) => {
                request.log.error(e);
                throw new DatabaseDeleteError({
                  message: "Failed to delete all existing students.",
                });
              });
            let enablePromises = [];
            for (const user of users) {
              enablePromises.push(
                tx.users.upsert({
                  where: {
                    netId_courseId: { courseId, netId: user.netId },
                  },
                  create: {
                    courseId,
                    netId: user.netId,
                    role: Role.STUDENT,
                    uin: user.uin,
                    enabled: true,
                  },
                  update: {
                    courseId,
                    netId: user.netId,
                    role: Role.STUDENT,
                    uin: user.uin,
                    enabled: true,
                  },
                }),
              );
            }
            const { redisClient } = fastify;
            const commitMessage = `Roster overwrite by ${adminNetId}\n\nRequest ID: ${request.id}`;
            const netIds = users.map((x) => x.netId).sort();
            const gheRosterPromise = overwriteRosterToGithub({
              redisClient,
              netIds,
              commitMessage,
              githubToken,
              orgName: githubOrg,
              repoName: rosterRepo,
              logger: request.log,
            });
            await Promise.all(enablePromises).catch((e) => {
              request.log.error(e);
              throw new DatabaseInsertError({
                message: "Failed to insert new students.",
              });
            });
            await gheRosterPromise;
          },
          { timeout: 15000 },
        )
        .catch((e) => {
          if (e instanceof BaseError) {
            throw e;
          }
          request.log.error(e);
          throw new DatabaseInsertError({
            message: "Could not overwrite student roster.",
          });
        });
      return reply.status(201).send();
    },
  );
};
export default rosterRoutes;
