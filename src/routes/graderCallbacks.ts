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
import { Category, JobStatus, JobType, Role } from "../generated/prisma/client.js";
import { updateStudentGradesToGithub } from "../functions/github.js";
import { getGroupForStudent } from "../functions/partners.js";
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
          courseId: z.string().min(1).optional(),
          assignmentId: z.string().min(1).optional(),
          isRegrade: z.boolean().default(false)
        }),
        params: z.object({
          id: z.string().min(1),
        }),
      },
    },
    async (request, reply) => {
      const { studentId, courseId, assignmentId, isRegrade, grade: rawGrade } = request.body;
      const { id } = request.params;

      try {
        await fastify.prismaClient.$transaction(async (tx) => {
          let job = await tx.job.findFirst({
            where: {
              id,
              status: JobStatus.RUNNING,
              type: { not: JobType.STUDENT_INITIATED },
              netId: { hasSome: [studentId, "_ALL_"] },
            },
            select: {
              id: true,
              courseId: true,
              assignmentId: true,
            },
          });

          if (!job) {
            if (!courseId || !assignmentId) {
              throw new ValidationError({
                message:
                  "courseId and assignmentId are required for non-registered runs.",
              });
            }
            request.log.info("No pre-registered run found, creating one");
            job = await tx.job.upsert({
              where: { id },
              create: {
                id,
                name: "Auto-registered job from Jenkins",
                courseId,
                assignmentId,
                netId: [],
                type: isRegrade ? JobType.REGRADE : JobType.STAFF_INITIATED,
                status: JobStatus.RUNNING,
                dueAt: new Date().toISOString(),
                scheduledAt: new Date().toISOString(),
                isScheduledJob: false,
              },
              update: {},
              select: {
                id: true,
                courseId: true,
                assignmentId: true,
              },
            });
          }

          // Calculate final grade with regrade logic
          let finalGrade = rawGrade;
          if (isRegrade) {
            // Apply regrade cap
            finalGrade = Math.min(rawGrade, config.REGRADE_CAP);

            // Ensure grade doesn't decrease from existing published grade
            const existingGrade = await tx.publishedGrades.findUnique({
              where: {
                courseId_assignmentId_netId: {
                  courseId: job.courseId,
                  assignmentId: job.assignmentId!,
                  netId: studentId,
                },
              },
              select: { score: true },
            });

            if (existingGrade) {
              finalGrade = Math.max(finalGrade, existingGrade.score);
            }
          }

          await tx.stagingGrades.upsert({
            where: {
              jobId_netId: {
                jobId: id,
                netId: studentId,
              },
              courseId: job.courseId,
            },
            update: {
              score: finalGrade,
            },
            create: {
              jobId: id,
              netId: studentId,
              score: finalGrade,
              courseId: job.courseId,
            },
          });
        });

        return reply.status(201).send();
      } catch (e) {
        fastify.log.error(e);
        if (e instanceof ValidationError) {
          throw e;
        }
        throw new ValidationError({ message: "Failed to process grading result." });
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
              select: { courseId: true, assignmentId: true, netId: true, type: true },
            });
            if (!jobData) {
              throw new ValidationError({
                message: "Could not find assignment ID for job.",
              });
            }
            const isRegrade = jobData.type === JobType.REGRADE;
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
                request.log.error(e);
                throw new DatabaseFetchError({
                  message: "Could not find course configuration.",
                });
              });
            const assignmentId = jobData["assignmentId"];
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
            if (!results || results.length === 0) {
              throw new ValidationError({
                message: "Could not find staging grades for job.",
              });
            }

            // Lab/Project partners: on the post-deadline final run, a group's published
            // grade is the max across whichever members actually have a result
            // in *this* run - not just whoever's run happened to complete last.
            if (jobData.type === JobType.FINAL_GRADING) {
              const assignment = await tx.assignment.findFirst({
                where: { courseId: jobData.courseId, id: assignmentId },
                select: { category: true, partnerRoundNumber: true },
              });
              if (
                (assignment?.category === Category.LAB ||
                  assignment?.category === Category.PROJECT) &&
                assignment.partnerRoundNumber != null
              ) {
                const roundNumber = assignment.partnerRoundNumber;
                const scoreByNetId = new Map(
                  results.map((r) => [r.netId, r.score]),
                );
                const groupMembersByNetId = new Map<string, string[]>();
                for (const result of results) {
                  if (groupMembersByNetId.has(result.netId)) continue;
                  const group = await getGroupForStudent({
                    tx,
                    courseId: jobData.courseId,
                    netId: result.netId,
                    roundNumber,
                  });
                  if (!group) continue;
                  const memberNetIds = group.members.map((m) => m.netId);
                  for (const netId of memberNetIds) {
                    groupMembersByNetId.set(netId, memberNetIds);
                  }
                }
                for (const result of results) {
                  const memberNetIds = groupMembersByNetId.get(result.netId);
                  if (!memberNetIds) continue;
                  const scoresPresent = memberNetIds
                    .map((netId) => scoreByNetId.get(netId))
                    .filter((score): score is number => score !== undefined);
                  if (scoresPresent.length < 2) continue;
                  result.score = Math.max(...scoresPresent);
                }
              }
            }

            // Staging grades already have correct scores (regrade logic applied in addGradingResult)
            const promises = results.map((x) => {
              return tx.publishedGrades.upsert({
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
              });
            });

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
              commitMessage: `Publish ${isRegrade ? "regrades" : "grades"} for ${assignmentId}\n\nJob ID ${id}`,
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
        await fastify.prismaClient
          .$transaction(async (tx) => {
            const currentStatus = await tx.job.findFirst({
              where: { id },
              select: { status: true },
            });
            const currentJobStatus = (currentStatus || { status: "none" })
              .status;
            const validStateTransitions =
              VALID_JOB_STATUS_TRANSITIONS[currentJobStatus];
            if (!validStateTransitions.includes(status)) {
              throw new ValidationError({
                message: `Invalid state transition. Valid transitions are: ${JSON.stringify(validStateTransitions)}.`,
              });
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
          })
          .catch((e) => {
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
