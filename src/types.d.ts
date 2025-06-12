import {
  type FastifyRequest,
  type FastifyInstance,
  type FastifyReply,
} from "fastify";
import { type FastifyOAuth2Namespace } from "@fastify/oauth2";
import { type JobScheduler } from "./scheduler/scheduler.ts";
import { type PrismaClient, type Role } from "./generated/prisma/client.ts";
import { type RedisClientType } from "redis";

declare module "fastify" {
  interface FastifyInstance {
    entraId: FastifyOAuth2Namespace;
    prismaClient: PrismaClient;
    redisClient: RedisClientType;
    scheduler: JobScheduler;
    jobSockets: Map<string, Set<WebSocket>>;
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
