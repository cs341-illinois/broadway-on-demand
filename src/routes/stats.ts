import { FastifyPluginAsync } from "fastify";
import { FastifyZodOpenApiTypeProvider } from "fastify-zod-openapi";
import { Role } from "../generated/prisma/client.js";
import { z } from "zod";
import { DatabaseFetchError } from "../errors/index.js";
import { StatsResponseSchema, StatsResponse } from "../types/stats.js";
import { calculateHistogramBins, calculateMean, calculateMedian, calculateStandardDeviation } from "../util.js";
import { HISTOGRAM_BIN_WIDTH, STATS_EXPIRY_SECS } from "../constants.js";

const statsRoutes: FastifyPluginAsync = async (fastify, _options) => {
  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().get(
    "/:courseId/assignment/:assignmentId/stats",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.ADMIN,
          Role.STAFF,
          Role.STUDENT,
        ]);
      },
      schema: {
        params: z.object({
          courseId: z.string().min(1),
          assignmentId: z.string().min(1),
        }),
        response: {
          200: StatsResponseSchema,
        }
      },
    },
    async (request, reply) => {
      const { courseId, assignmentId } = request.params;
      const cacheKey = `stats:${courseId}:${assignmentId}`;
      const cached = await fastify.redisClient.get(cacheKey);
      if (cached) {
        return reply.send(JSON.parse(cached));
      }

      const publishedGrades = (
        await fastify.prismaClient.publishedGrades
          .findMany({
            where: {
              courseId,
              assignmentId,
            },
            select: {
              score: true,
            },
            orderBy: {
              score: 'asc'
            }
          })
          .catch((e) => {
            request.log.error(e);
            throw new DatabaseFetchError({
              message: "Failed to get published grades.",
            });
          })
      );

      const scores = publishedGrades.map(grade => grade.score);

      const response: StatsResponse = {
        meanScore: Math.round(calculateMean(scores) * 100)/100,
        medianScore: Math.round(calculateMedian(scores, true) * 100)/100,
        standardDeviation: Math.round(calculateStandardDeviation(scores) * 100)/100,
        binValues: calculateHistogramBins(scores, HISTOGRAM_BIN_WIDTH, 0, 100),
      }

      await fastify.redisClient.set(cacheKey, JSON.stringify(response), { EX: STATS_EXPIRY_SECS });
      await reply.send(response);
    },
  );
};

export default statsRoutes;
