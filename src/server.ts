import "zod-openapi/extend";
import { resolve } from "node:path";
import FastifyVite from "@fastify/vite";
import Fastify, { fastify } from "fastify";
import FastifyCookie from "@fastify/cookie";
import FastifySession from "@fastify/session";
import fastifyOAuth2, { FastifyOAuth2Options } from "@fastify/oauth2";
import config from "./config.js";
import { getUserRolesByNetId } from "./functions/userData.js";
import { JobScheduler } from "./scheduler/scheduler.js";
import { PrismaJobRepository } from "./scheduler/prismaRepository.js";
import fastifyAuthPlugin from "./plugins/auth.js";
import courseRoutes from "./routes/course.js";
import {
  type FastifyZodOpenApiSchema,
  type FastifyZodOpenApiTypeProvider,
  serializerCompiler,
  validatorCompiler,
} from "fastify-zod-openapi";
import errorHandlerPlugin from "./plugins/errorHandler.js";
import { PrismaClient } from "@prisma/client";

async function start() {
  const server = Fastify({ logger: { level: "info" } });
  server.prismaClient = new PrismaClient();
  server.setValidatorCompiler(validatorCompiler);
  server.setSerializerCompiler(serializerCompiler);
  server.scheduler = new JobScheduler(new PrismaJobRepository(), {
    logger: server.log,
  });
  server.scheduler.registerHandler(
    "runScheduledGradingJob",
    async (job, logger) => {
      logger.info(`Processing ${job.type}`);
    },
  );

  server.scheduler.start();
  await server.register(errorHandlerPlugin);
  await server.register(fastifyAuthPlugin);
  await server.register(FastifyVite, {
    root: resolve(import.meta.dirname, "../"),
    dev: process.argv.includes("--dev"),
    spa: true,
    prefix: config.BASE_URL,
  });
  await server.register(FastifyCookie, {
    secret: config.COOKIE_SECRET,
  });
  await server.register(FastifySession, {
    cookieName: "sessionId",
    secret: config.COOKIE_SECRET,
    cookie: {
      secure: config.NODE_ENV === "production",
      httpOnly: true,
      maxAge: 86400000, // 1 day in milliseconds
    },
    saveUninitialized: false,
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
      maxAge: 86400000, // 1 day
    },
  } as FastifyOAuth2Options);
  server.get(config.BASE_URL, (req, reply) => {
    return reply.html();
  });
  server.get(`${config.BASE_URL}/*`, (req, reply) => {
    return reply.html();
  });
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
    if (!request.session || !request.session.user) {
      return reply.redirect(config.BASE_URL);
    }
    request.session.destroy();
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
      api.register(courseRoutes, { prefix: "/courses" });
    },
    { prefix: `${config.BASE_URL}/api/v1` },
  );

  await server.vite.ready();
  return server;
}

const server = await start();
try {
  await server.listen({ host: "localhost", port: config.PORT });
} catch (err) {
  server.log.error(err);
  process.exit(1);
}
