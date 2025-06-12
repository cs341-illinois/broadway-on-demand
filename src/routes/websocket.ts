import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { FastifyZodOpenApiTypeProvider } from "fastify-zod-openapi";
import { subscribePayload } from "../types/websocket.js";
import { Role } from "../generated/prisma/enums.js";

const websocketRoutes: FastifyPluginAsync = async (fastify, _options) => {
  fastify.get("/hello", { websocket: true }, async (connection, reply) => {
    connection.on("message", (message) => {
      connection.send("Hello");
    });
  });
  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().get(
    "/job/:courseId",
    {
      schema: {
        params: z.object({
          courseId: z.string().min(1),
        }),
      },
      websocket: true,
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.STUDENT,
          Role.STAFF,
          Role.ADMIN,
        ]);
      },
    },
    async (connection, reply) => {
      connection.on("message", async (message) => {
        fastify.log.debug("Opening subscription.");
        const stMessage = message.toString();
        try {
          const data = await subscribePayload.parseAsync(JSON.parse(stMessage));
          for (const item of data.jobs) {
            if (!fastify.jobSockets.has(item)) {
              fastify.jobSockets.set(item, new Set());
            }
            fastify.jobSockets.get(item)!.add(connection);
          }
          connection.send("OK");
        } catch (e) {
          connection.send("ERROR");
          fastify.log.error(e);
          connection.close();
        }
      });

      connection.on("close", () => {
        fastify.log.debug("Closing subscription.");
        try {
          fastify.jobSockets.forEach((subscribers, topic) => {
            if (subscribers.has(connection)) {
              subscribers.delete(connection);
              if (subscribers.size === 0) {
                fastify.jobSockets.delete(topic);
              }
            }
          });
        } catch (e) {
          fastify.log.error(e);
          connection.send("ERROR");
          connection.close();
        }
      });
    },
  );
};

export default websocketRoutes;
