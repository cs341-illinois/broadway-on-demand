/* eslint-disable @typescript-eslint/no-unused-vars */
import { FastifyRequest, FastifyInstance, FastifyReply } from "fastify";
import { FastifyOAuth2Namespace } from "@fastify/oauth2";
import { type JobScheduler } from "./scheduler/scheduler.ts";
import { type PrismaClient, Role } from "@prisma/client";

declare module "fastify" {
  interface FastifyInstance {
    entraId: FastifyOAuth2Namespace;
    prismaClient: PrismaClient;
    scheduler: JobScheduler;
    authorize: (
      request: FastifyRequest,
      reply: FastifyReply,
      courseId: string,
      validRoles: Role[],
    ) => Promise<void>;
  }
  interface Session {
    token?: OAuth2Token;
    user?: SessionUser;
    isAuthenticated?: boolean;
  }
}
