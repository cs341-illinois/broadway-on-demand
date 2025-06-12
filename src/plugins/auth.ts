import { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { Role } from "../generated/prisma/client.js";
import { getCourseRoles } from "../functions/userData.js";
import { UnauthenticatedError, UnauthorizedError } from "../errors/index.js";

export function intersection<T>(setA: Set<T>, setB: Set<T>): Set<T> {
  const _intersection = new Set<T>();
  for (const elem of setB) {
    if (setA.has(elem)) {
      _intersection.add(elem);
    }
  }
  return _intersection;
}

const authPlugin: FastifyPluginAsync = async (fastify, _options) => {
  fastify.decorate(
    "authorize",
    async (
      request: FastifyRequest,
      _reply: FastifyReply,
      courseId: string,
      validRoles: Role[],
    ): Promise<void> => {
      if (!request.session || !request.session.user) {
        throw new UnauthenticatedError({ message: "No session found." });
      }
      const courseRoles = new Set(
        getCourseRoles(courseId, request.session.user.roles),
      );
      if (intersection(courseRoles, new Set(validRoles)).size === 0) {
        throw new UnauthorizedError({
          message: "You do not have permission to perform this action.",
        });
      }
    },
  );
};

const fastifyAuthPlugin = fp(authPlugin);
export default fastifyAuthPlugin;
