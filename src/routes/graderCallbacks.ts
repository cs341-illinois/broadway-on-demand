import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { FastifyZodOpenApiTypeProvider } from "fastify-zod-openapi";
import config from "../config.js";
import {
  BaseError,
  DatabaseFetchError,
  DatabaseInsertError,
  GithubError,
  UnauthorizedError,
  ValidationError,
} from "../errors/index.js";
import { JobStatus, JobType, Role } from "../generated/prisma/client.js";
import { updateStudentGradesToGithub } from "../functions/github.js";
import { jobResponse } from "../types/websocket.js";
import { type WebSocket } from "ws";
import { VALID_JOB_STATUS_TRANSITIONS } from "../constants.js";

const graderCallbackRoutes: FastifyPluginAsync = async (fastify, _options) => {
  fastify.get("/", {}, async (request, reply) => {
    return reply.status(200).send("Callback available.");
  });
  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().post(
    "/addGradingResult/:id",
    {
      onRequest: async (request, reply) => {
        if (
          request.headers["authorization"] !== `Bearer ${config.GRADER_TOKEN}`
        ) {
          return reply
            .status(401)
            .send({ error: true, message: "Not authorized" });
        }
      },
      schema: {
        body: z.object({
          studentId: z.string().min(1),
          grade: z.number().min(0).max(100),
        }),
        params: z.object({
          id: z.string().min(1),
        }),
      },
    },
    async (request, reply) => {
      const { studentId, grade } = request.body;
      const { id } = request.params;
      try {
        const result = await fastify.prismaClient.job.findFirst({
          where: {
            id,
            status: JobStatus.RUNNING,
            type: { not: JobType.STUDENT_INITIATED },
            netId: { hasSome: [studentId, "_ALL_"] },
          },
          select: {
            _count: true,
            courseId: true,
          },
        });
        if (!result) {
          throw new ValidationError({
            message: "Could not find registered eligible grading run.",
          });
        }
        await fastify.prismaClient.stagingGrades.upsert({
          where: {
            jobId_netId: {
              jobId: id,
              netId: studentId,
            },
            courseId: result.courseId,
          },
          update: {
            score: grade,
          },
          create: {
            jobId: id,
            netId: studentId,
            score: grade,
            courseId: result.courseId,
          },
        });
        return reply.status(201).send();
      } catch (e) {
        fastify.log.error(e);
        throw new ValidationError({ message: "Run is not registered." });
      }
    },
  );
  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().post(
    "/completeGradingRun/:id",
    {
      onRequest: async (request, reply) => {
        if (
          request.headers["authorization"] !== `Bearer ${config.GRADER_TOKEN}`
        ) {
          return reply
            .status(401)
            .send({ error: true, message: "Not authorized" });
        }
      },
      schema: {
        params: z.object({
          id: z.string().min(1),
        }),
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      try {
        await fastify.prismaClient
          .$transaction(async (tx) => {
            const jobData = await tx.job.findFirst({
              where: { id },
              select: { courseId: true, assignmentId: true, netId: true },
            });
            if (!jobData) {
              throw new ValidationError({
                message: "Could not find assignment ID for job.",
              });
            }
            const { githubOrg, githubToken, gradesRepo } = await tx.course
              .findFirstOrThrow({
                where: {
                  id: jobData.courseId,
                },
                select: {
                  githubOrg: true,
                  githubToken: true,
                  gradesRepo: true,
                },
              })
              .catch((e) => {
                throw new DatabaseFetchError({
                  message: "Could not find course configuration.",
                });
              });
            const assignmentId = jobData["assignmentId"];
            const users = jobData["netId"];
            let usersLength: number = users.length;
            const results = await tx.stagingGrades.findMany({
              where: {
                jobId: id,
              },
              select: {
                courseId: true,
                netId: true,
                score: true,
                comments: true,
              },
            });
            if (users.length === 1 && users[0] === "_ALL_") {
              usersLength = await tx.users.count({
                where: {
                  courseId: results[0].courseId,
                  role: Role.STUDENT,
                  enabled: true,
                },
              });
            }
            if (!results) {
              throw new ValidationError({
                message: "Could not find staging grades for job.",
              });
            }
            if (usersLength !== results.length) {
              throw new ValidationError({
                message: `Found ${results.length} grades to publish but expected ${usersLength} results!`,
              });
            }
            const promises = results.map((x) =>
              tx.publishedGrades.upsert({
                where: {
                  courseId_assignmentId_netId: {
                    courseId: results[0].courseId,
                    assignmentId,
                    netId: x.netId,
                  },
                },
                create: {
                  courseId: results[0].courseId,
                  assignmentId,
                  netId: x.netId,
                  score: x.score,
                  comments: x.comments,
                },
                update: {
                  score: x.score,
                  comments: x.comments,
                },
              }),
            );
            await Promise.allSettled(promises);
            await tx.stagingGrades.deleteMany({
              where: {
                jobId: id,
              },
            });
            await tx.job.update({
              where: {
                id,
              },
              data: {
                status: JobStatus.COMPLETED,
              },
            });
            const gradeData = results.map((x) => ({
              netId: x.netId,
              score: x.score,
            }));
            await updateStudentGradesToGithub({
              redisClient: fastify.redisClient,
              assignmentId,
              gradeData,
              orgName: githubOrg,
              repoName: gradesRepo,
              githubToken,
              commitMessage: `Publish grades for ${assignmentId}\n\nJob ID ${id}`,
              logger: request.log,
            }).catch((e) => {
              if (e instanceof BaseError) {
                throw e;
              }
              request.log.error(e);
              throw new GithubError({
                message: "Failed to push changes to GitHub.",
              });
            });
          })
          .catch((e) => {
            if (e instanceof BaseError) {
              throw e;
            }
            fastify.log.error(e);
            throw new DatabaseInsertError({
              message: "Could not publish grades.",
            });
          });
        return reply.status(201).send();
      } catch (e) {
        fastify.log.error(e);
        throw new ValidationError({ message: "Run is not registered." });
      }
    },
  );
  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().post(
    "/statusping/:id",
    {
      onRequest: async (request, reply) => {
        if (
          request.headers["authorization"] !== `Bearer ${config.GRADER_TOKEN}`
        ) {
          throw new UnauthorizedError({
            message: "Could not authenticate token.",
          });
        }
      },
      schema: {
        body: z.object({
          status: z.nativeEnum(JobStatus),
          buildUrl: z.string().url(),
        }),
        params: z.object({
          id: z.string().min(1),
        }),
      },
    },
    async (request, reply) => {
      const { status, buildUrl } = request.body;
      const { id } = request.params;
      try {
        await fastify.prismaClient.$transaction(async (tx) => {
          const currentStatus = await tx.job.findFirst({
            where: { id },
            select: { status: true }
          });
          const currentJobStatus = (currentStatus || { status: 'none' }).status;
          const validStateTransitions = VALID_JOB_STATUS_TRANSITIONS[currentJobStatus];
          if (!(validStateTransitions.includes(status))) {
            throw new ValidationError({ message: `Invalid state transition. Valid transitions are: ${JSON.stringify(validStateTransitions)}.` })
          }
          await tx.job
            .update({
              where: {
                id,
              },
              data: {
                status,
                buildUrl,
              },
            })
            .catch((e) => {
              fastify.log.error(e);
              throw new DatabaseInsertError({
                message: "Could not update status.",
              });
            });
        }).catch((e) => {
          if (e instanceof BaseError) {
            throw e;
          }
          throw new DatabaseInsertError({
            message: "Could not update status.",
          });
        });
        reply.status(201).send();
      } catch (e) {
        if (e instanceof BaseError) {
          throw e;
        }
        fastify.log.error(e);
        throw new DatabaseInsertError({ message: "Could not update status." });
      }
      const sockets = fastify.jobSockets.get(id);
      if (sockets) {
        request.log.debug(`Sending info over sockets for job ${id}.`);
        const parsedPayload = await jobResponse.parseAsync({ id, status });
        for (const socket of sockets) {
          const casted = socket as WebSocket;
          try {
            if (casted.OPEN) {
              request.log.debug("Socket open, sending info.");
              casted.send(JSON.stringify(parsedPayload));
            } else {
              request.log.debug("Socket closed, not sending info.");
            }
          } catch (e) {
            request.log.error(
              `Error sending updates to sockets for job ID ${id}`,
              e,
            );
            socket.close();
          }
        }
      }
    },
  );
};

export default graderCallbackRoutes;
