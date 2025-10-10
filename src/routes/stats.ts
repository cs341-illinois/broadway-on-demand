import { FastifyPluginAsync } from "fastify";
import { FastifyZodOpenApiTypeProvider } from "fastify-zod-openapi";
import { Role } from "../generated/prisma/client.js";
import { z } from "zod";
import { DatabaseFetchError } from "../errors/index.js";
import { StatsResponseSchema, StatsResponse } from "../types/stats.js";

const calculateMean = (arr: any[]) => {
  if (arr.length === 0) return 0;
  const sum = arr.reduce((acc: any, curr: any) => acc + curr, 0);
  return sum / arr.length;
};
const calculateMedian = (arr: string | any[]) => {
  if (arr.length === 0) return 0;
  const sortedArr = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sortedArr.length / 2);

  if (sortedArr.length % 2 === 0) {
    return (sortedArr[mid - 1] + sortedArr[mid]) / 2;
  } else {
    return sortedArr[mid];
  }
};
const calculateStandardDeviation = (arr: any[]) => {
  if (arr.length === 0) return 0;
  const mean = calculateMean(arr);
  const squaredDifferences = arr.map((num: number) => Math.pow(num - mean, 2));
  const sumOfSquaredDifferences = squaredDifferences.reduce((acc: any, curr: any) => acc + curr, 0);
  const variance = sumOfSquaredDifferences / arr.length;
  return Math.sqrt(variance);
};
const calculateHistogramBins = (arr: string | any[], numBins: number, start: number, end: number) => {
    const binSize = (end - start) / numBins;
    const bins = Array(numBins).fill(0);
    for (const val of arr) {
        const binIndex = Math.min(Math.floor((val - start) / binSize), numBins - 1);
        bins[binIndex] += 1;
    }
    return bins;
};

const statsRoutes: FastifyPluginAsync = async (fastify, _options) => {
    fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().get(
        "/:courseId/assignment/:assignmentId/stats",
        {
            onRequest: async(request, reply) => {
                await fastify.authorize(request, reply, request.params.courseId, [
                   Role.ADMIN,
                   Role.STAFF,
                   Role.STUDENT, 
                ]);
            },
            schema: {
                params:  z.object({
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
                meanScore: calculateMean(scores),
                medianScore: calculateMedian(scores),
                standardDeviation: calculateStandardDeviation(scores),
                binValues: calculateHistogramBins(scores, 10, 0, 100),
            }

            await fastify.redisClient.set(cacheKey, JSON.stringify(response), { EX: 86400});
            await reply.send(response);
        },
    );
};

export default statsRoutes;