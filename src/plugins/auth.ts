import { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { Role } from "../generated/prisma/client.js";
import { getCourseRoles, getUserRolesByNetId } from "../functions/userData.js";
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
      let roles = request.session.user.roles;
      if (Math.random() < 0.2) {
        // fire-and-forget
        (async () => {
          try {
            const netId = request.session.user!.email.replace(
              "@illinois.edu",
              "",
            );
            const newRoles = await getUserRolesByNetId(netId);
            request.session.user!.roles = newRoles;
            await request.session.save();
            fastify.log.debug(`Refreshed roles for ${netId}`);
          } catch (e) {
            fastify.log.error(`Background role refresh failed: ${e}`);
            await request.session.destroy();
          }
        })();
      }
      const courseRoles = new Set(getCourseRoles(courseId, roles));
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
