import { FastifyPluginAsync } from "fastify";
import { FastifyZodOpenApiTypeProvider } from "fastify-zod-openapi";
import { z } from "zod";
import { Role } from "../generated/prisma/client.js";
import { getGradebookForStudent } from "../functions/gradebook.js";
import { gradebookResponse } from "../types/gradebook.js";

const gradebookRoutes: FastifyPluginAsync = async (fastify, _options) => {
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
          200: gradebookResponse,
        },
      },
    },
    async (request, reply) => {
      const { courseId } = request.params;
      const netId = (request.session.user!.email as string).replace(
        "@illinois.edu",
        "",
      );
      const gradebook = await fastify.prismaClient.$transaction(async (tx) => {
        return await getGradebookForStudent({
          tx,
          courseId,
          netId,
          logger: request.log,
        });
      });
      return reply.send(gradebook);
    },
  );
};

export default gradebookRoutes;
