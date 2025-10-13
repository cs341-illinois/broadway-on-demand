import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import "zod-openapi/extend";
import path, { resolve } from "node:path";
import FastifyVite from "@fastify/vite";
import Fastify from "fastify";
import FastifyCookie from "@fastify/cookie";
import FastifyWebsocket from "@fastify/websocket";
import fastifyOAuth2, { FastifyOAuth2Options } from "@fastify/oauth2";
import config from "./config.js";
import { getUserRolesByNetId } from "./functions/userData.js";
import { JobScheduler } from "./scheduler/scheduler.js";
import { PrismaJobRepository } from "./scheduler/prismaRepository.js";
import { JobReconciler } from "./reconciler/index.js";
import fastifyAuthPlugin from "./plugins/auth.js";
import FastifyStatic from "@fastify/static";
import courseRoutes from "./routes/course.js";
import { serializerCompiler, validatorCompiler } from "fastify-zod-openapi";
import errorHandlerPlugin from "./plugins/errorHandler.js";
import { JobType, PrismaClient, Role } from "./generated/prisma/client.js";
import { randomUUID } from "node:crypto";
import gradesRoutes from "./routes/grades.js";
import rosterRoutes from "./routes/roster.js";
import fastifySession from "@fastify/session";
import RedisStore from "fastify-session-redis-store";
import { createClient } from "redis";
import graderCallbackRoutes from "./routes/graderCallbacks.js";
import { startScheduledJob } from "./scheduler/handlers.js";
import extensionRoutes from "./routes/extension.js";
import studentInfoRoutes from "./routes/studentInfo.js";
import attendanceRoutes from "./routes/attendance.js";
import { type WebSocket } from "ws";
import websocketRoutes from "./routes/websocket.js";
import statsRoutes from "./routes/stats.js";

const SESSION_TTL = 86400 * 1000; // 1 day in seconds

async function start() {
  const server = Fastify({
    logger: { level: config.LOG_LEVEL },
    genReqId: () => randomUUID().toString(),
    trustProxy: true,
  });

  process.on('uncaughtException', err => {
    server.log.fatal({ msg: 'Uncaught exception', err });
    throw err;
  });

  process.on('unhandledRejection', reason => {
    const err = new Error(`Unhanded rejection. Reason: ${reason}`);
    server.log.error({ msg: 'Unhandled rejection', err });
  });

  server.jobSockets = new Map<string, Set<WebSocket>>();
  server.prismaClient = new PrismaClient({
    transactionOptions: {
      maxWait: 10_000,
      timeout: 20_000,
    },
  });
  server.redisClient = createClient({ url: config.REDIS_URL });
  await server.redisClient.connect();
  let redisStore = new RedisStore({
    client: server.redisClient,
    prefix: "on_demand-session:",
    ttl: SESSION_TTL,
  });

  server.setValidatorCompiler(validatorCompiler);
  server.setSerializerCompiler(serializerCompiler);
  server.scheduler = new JobScheduler(new PrismaJobRepository(), {
    logger: server.log,
  });
  server.scheduler.registerHandler(
    JobType.FINAL_GRADING,
    async (job, logger) => {
      const { redisClient, prismaClient } = server;
      return await startScheduledJob({
        job,
        logger,
        redisClient,
        prismaClient,
      });
    },
  );
  server.scheduler.registerHandler(JobType.REGRADE, async (job, logger) => {
    const { redisClient, prismaClient } = server;
    return await startScheduledJob({ job, logger, redisClient, prismaClient });
  });
  server.scheduler.start();
  server.reconciler = new JobReconciler(server.prismaClient, {
    logger: server.log
  })
  server.reconciler.start();
  await server.register(errorHandlerPlugin);
  await server.register(fastifyAuthPlugin);
  if (process.argv.includes("--dev")) {
    await server.register(FastifyVite, {
      root: resolve(import.meta.dirname, "../"),
      dev: true,
      spa: true,
      prefix: config.BASE_URL,
      distDir: resolve(import.meta.dirname, "../dist/ui"),
    });
    server.get(config.BASE_URL, (req, reply) => {
      return reply.html();
    });
    server.get(`${config.BASE_URL}/*`, (req, reply) => {
      return reply.html();
    });
    await server.vite.ready();
  } else {
    await server.register(FastifyStatic, {
      root: resolve(import.meta.dirname, "../dist/ui/"),
      prefix: `${config.BASE_URL}`,
    });
  }
  await server.register(FastifyCookie, {
    secret: config.COOKIE_SECRET,
  });
  await server.register(FastifyWebsocket, {
    errorHandler: function (error, socket, req, reply) {
      req.log.error(error);
      socket.terminate();
    },
  });
  await server.register(fastifySession, {
    cookieName: "sessionId",
    secret: config.COOKIE_SECRET,
    cookie: {
      secure: config.NODE_ENV === "production",
      httpOnly: true,
      maxAge: SESSION_TTL, // 1 day in milliseconds
    },
    saveUninitialized: false,
    store: redisStore,
    rolling: false,
  });
  await server.register(fastifyOAuth2, {
    name: "entraId",
    scope: ["openid", "email", "profile", "User.Read"], // You can customize scopes
    credentials: {
      client: {
        id: config.AZURE_CLIENT_ID,
        secret: config.AZURE_CLIENT_SECRET,
      },
      auth: {
        authorizeHost: "https://login.microsoftonline.com",
        authorizePath: `/${config.AZURE_TENANT_ID}/oauth2/v2.0/authorize`,
        tokenHost: "https://login.microsoftonline.com",
        tokenPath: `/${config.AZURE_TENANT_ID}/oauth2/v2.0/token`,
      },
    },
    startRedirectPath: `${config.BASE_URL}/login/entra`,
    callbackUri: `${config.HOST}${config.BASE_URL}/login/entra/callback`,
    cookie: {
      secure: config.NODE_ENV === "production",
      httpOnly: true,
      maxAge: SESSION_TTL, // 1 day
    },
  } as FastifyOAuth2Options);
  server.get(`${config.BASE_URL}/api/v1/pingz`, (req, reply) => {
    return reply.send("OK");
  });

  server.get(
    `${config.BASE_URL}/login/entra/callback`,
    {},
    async (request, reply) => {
      try {
        const { token } =
          await server.entraId.getAccessTokenFromAuthorizationCodeFlow(request);
        request.session.token = token;
        const userResponse = await fetch(
          "https://graph.microsoft.com/v1.0/me",
          {
            headers: {
              Authorization: `Bearer ${token.access_token}`,
              "Content-Type": "application/json",
            },
          },
        );

        if (!userResponse.ok) {
          throw new Error(
            `Failed to fetch user profile: ${userResponse.statusText}`,
          );
        }
        const userProfile = (await userResponse.json()) as any;
        request.session.user = {
          id: userProfile.id,
          displayName: userProfile.displayName,
          email: userProfile.mail || userProfile.userPrincipalName,
          givenName: userProfile.givenName,
          surname: userProfile.surname,
        };
        const roles = await getUserRolesByNetId(
          request.session.user.email.replace("@illinois.edu", ""),
        );
        request.session.user.roles = roles;
        server.log.info(`User authenticated: ${request.session.user.email}`);
        await request.session.save();
        return reply.redirect(`${config.BASE_URL}/dashboard`);
      } catch (error) {
        if (error instanceof Error) {
          server.log.error(`Authentication error: ${error.message}`);
        }
        return reply.code(500).send("Authentication failed");
      }
    },
  );

  server.post(`${config.BASE_URL}/logout`, {}, async (request, reply) => {
    await request.session.destroy();
    if (!request.session || !request.session.user) {
      return reply.redirect(config.BASE_URL);
    }
  });

  server.get(
    `${config.BASE_URL}/api/v1/profile`,
    {},
    async (request, reply) => {
      if (!request.session || !request.session.user) {
        return reply
          .status(401)
          .send({ error: true, message: "Not logged in." });
      }
      return reply.send(request.session.user);
    },
  );
  await server.register(
    async (api, _options) => {
      await api.register(graderCallbackRoutes, { prefix: "/callback" });
      await api.register(courseRoutes, { prefix: "/courses" });
      await api.register(gradesRoutes, { prefix: "/grades" });
      await api.register(statsRoutes, { prefix: "/stats"})
      await api.register(rosterRoutes, { prefix: "/roster" });
      await api.register(extensionRoutes, { prefix: "/extension" });
      await api.register(studentInfoRoutes, { prefix: "/studentInfo" });
      await api.register(attendanceRoutes, { prefix: "/attendance" });
      await api.register(websocketRoutes, { prefix: "/ws" });
    },
    { prefix: `${config.BASE_URL}/api/v1` },
  );

  if (config.BASE_URL != "/") {
    server.get("/", {}, async (request, reply) => {
      return reply.redirect(config.BASE_URL);
    });
  }
  return server;
}

const server = await start();
try {
  await server.listen({ host: "0.0.0.0", port: config.PORT });
} catch (err) {
  server.log.error(err);
  process.exit(1);
}
