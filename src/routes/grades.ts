import {
  AssignmentVisibility,
  Category,
  Role,
} from "../generated/prisma/client.js";
import { FastifyPluginAsync } from "fastify";
import { FastifyZodOpenApiTypeProvider } from "fastify-zod-openapi";
import { z } from "zod";
import {
  getAssignmentGradesResponse,
  getUserGradesResponseSchema,
} from "../types/grades.js";
import { getUserGrades } from "../functions/grades.js";
import { updateStudentGradesToGithub } from "../functions/github.js";
import {
  BaseError,
  DatabaseFetchError,
  DatabaseInsertError,
  GithubError,
} from "../errors/index.js";
import { netIdSchema } from "../types/index.js";

const gradesRoutes: FastifyPluginAsync = async (fastify, _options) => {
  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().get(
    "/:courseId/me",
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
          200: getUserGradesResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { courseId } = request.params;
      const netId = (request.session.user!.email as string).replace(
        "@illinois.edu",
        "",
      );
      const mappedGrades = await fastify.prismaClient.$transaction(
        async (tx) => {
          return await getUserGrades({
            tx,
            courseId,
            netId,
            logger: request.log,
          });
        },
      );
      return reply.send(mappedGrades);
    },
  );
  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().post(
    "/:courseId/user/:netId",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.ADMIN,
        ]);
      },
      schema: {
        params: z.object({
          courseId: z.string().min(1),
          netId: netIdSchema,
        }),
        body: z.object({
          updates: z.record(
            z.string().min(1),
            z.object({
              score: z.number().min(0),
              comments: z.optional(z.string().nullable()),
            }),
          ),
          justification: z.string().min(1),
        }),
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
      const { courseId, netId } = request.params;
      const { updates, justification } = request.body;
      await fastify.prismaClient
        .$transaction(async (tx) => {
          const { githubOrg, githubToken, gradesRepo } = await tx.course
            .findFirstOrThrow({
              where: {
                id: courseId,
              },
              select: { githubOrg: true, githubToken: true, gradesRepo: true },
            })
            .catch((e) => {
              throw new DatabaseFetchError({
                message: "Could not find course configuration.",
              });
            });
          const upsertPromises = Object.entries(updates).map(
            ([assignmentId, updateData]) =>
              tx.publishedGrades.upsert({
                where: {
                  courseId_assignmentId_netId: {
                    courseId,
                    assignmentId,
                    netId,
                  },
                  Users: {
                    courseId,
                    netId,
                    enabled: true,
                  },
                },
                update: {
                  score: updateData.score,
                  comments: updateData.comments,
                },
                create: {
                  courseId,
                  netId,
                  assignmentId,
                  score: updateData.score,
                  comments: updateData.comments,
                },
              }),
          );
          await Promise.all(upsertPromises).catch((e) => {
            if (e instanceof BaseError) {
              throw e;
            }
            request.log.error(e);
            throw new DatabaseInsertError({ message: "Failed to insert data" });
          });
          // update GHE
          const githubUpdatePromises = Object.entries(updates).map(
            async ([assignmentId, updateData]) => {
              await updateStudentGradesToGithub({
                redisClient: fastify.redisClient,
                assignmentId,
                gradeData: [{ netId, score: updateData.score, comments: updateData.comments || "" }],
                githubToken,
                orgName: githubOrg,
                repoName: gradesRepo,
                commitMessage: `Grade Update for assignment ${assignmentId} by ${requestorNetId}\n\nReason: ${justification}\nRequest ID: ${request.id}`,
                logger: request.log,
              }).catch((e) => {
                request.log.error(e);
                throw new GithubError({
                  message: `Failed to update grades for assignment ${assignmentId}`,
                });
              });
            },
          );
          await Promise.all(githubUpdatePromises).catch((e) => {
            if (e instanceof BaseError) {
              throw e;
            }
            request.log.error(e);
            throw new GithubError({ message: `Failed to update grades.` });
          });
        })
        .catch((e) => {
          if (e instanceof BaseError) {
            throw e;
          }
          request.log.error(e);
          throw new DatabaseInsertError({ message: "Failed to modify grade." });
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
          200: getAssignmentGradesResponse,
        },
      },
    },
    async (request, reply) => {
      const { courseId, assignmentId } = request.params;
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
      return reply.send({ publishedGrades });
    },
  );
};

export default gradesRoutes;
