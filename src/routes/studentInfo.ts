import { FastifyPluginAsync } from "fastify";
import { FastifyZodOpenApiTypeProvider } from "fastify-zod-openapi";
import { z } from "zod";
import { getUserGrades } from "../functions/grades.js";
import { Role } from "../generated/prisma/client.js";
import {
  BaseError,
  DatabaseFetchError,
  NotFoundError,
} from "../errors/index.js";
import { studentInfoResponse } from "../types/studentInfo.js";
import { netIdSchema } from "../types/index.js";

const studentInfoRoutes: FastifyPluginAsync = async (fastify, _options) => {
  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().get(
    "/:courseId/user/:netId",
    {
      schema: {
        params: z.object({
          courseId: z.string().min(1),
          netId: netIdSchema,
        }),
        response: {
          200: studentInfoResponse,
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
      const { courseId, netId } = request.params;
      const userData = await fastify.prismaClient
        .$transaction(async (tx) => {
          const { name: courseName } = await tx.course.findFirstOrThrow({
            where: { id: courseId },
            select: { name: true },
          });
          const meta = await tx.users
            .findUniqueOrThrow({
              select: {
                name: true,
                uin: true,
                role: true,
                netId: true,
                enabled: true,
              },
              where: {
                netId_courseId: {
                  netId,
                  courseId,
                },
              },
            })
            .catch((e) => {
              throw new NotFoundError({ endpointName: request.url });
            });
          const grades = await getUserGrades({
            tx,
            courseId,
            netId,
            logger: request.log,
          });
          const extensions = await tx.extensions.findMany({
            where: {
              courseId,
              netId,
            },
            select: {
              assignmentId: true,
              openAt: true,
              closeAt: true,
              createdBy: true,
              Assignment: {
                select: {
                  name: true,
                },
              },
              extensionType: true,
            },
          });
          const mappedExtensions = extensions.map((x) => ({
            ...x,
            openAt: x.openAt.toISOString(),
            closeAt: x.closeAt.toISOString(),
            name: x.Assignment.name,
            initiator: x.extensionType,
          }));
          return {
            meta: { ...meta, courseName },
            grades,
            extensions: mappedExtensions,
          };
        })
        .catch((e) => {
          if (e instanceof BaseError) {
            throw e;
          }
          fastify.log.error(e);
          throw new DatabaseFetchError({ message: "Could not get data." });
        });
      return reply.send(userData);
    },
  );
};

export default studentInfoRoutes;
