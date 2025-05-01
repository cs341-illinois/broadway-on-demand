import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { FastifyZodOpenApiTypeProvider } from "fastify-zod-openapi";
import config from "../config.js";

const graderCallbackRoutes: FastifyPluginAsync = async (fastify, _options) => {
  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().post(
    "/register",
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
          runId: z.string().min(1),
          courseId: z.string().min(1),
          assignmentId: z.string().min(1),
        }),
      },
    },
    async (request, reply) => {
      const { courseId, assignmentId, runId } = request.body;
      await fastify.prismaClient.registeredGradingJobs.create({
        data: {
          id: runId,
          courseId,
          assignmentId,
        },
      });
      reply.status(201).send();
    },
  );
  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().post(
    "/result",
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
          runId: z.string().min(1),
          studentId: z.string().min(1),
          grade: z.number().min(0).max(100),
        }),
      },
    },
    async (request, reply) => {
      const { studentId, grade, runId } = request.body;
      try {
        await fastify.prismaClient.stagingGrades.create({
          data: {
            jobId: runId,
            netId: studentId,
            score: grade,
          },
        });
        reply.status(201).send();
      } catch (e) {
        fastify.log.error(e);
        return reply.status(400).send({
          error: true,
          message: "Invalid Run ID - run is not registered.",
        });
      }
    },
  );
};

export default graderCallbackRoutes;
