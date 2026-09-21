import { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import {
  BaseError,
  InternalServerError,
  NotFoundError,
  ValidationError,
} from "../errors/index.js";
import { resolve } from "node:path";
import config from "../config.js";

const errorHandlerPlugin = fp(async (fastify) => {
  fastify.setErrorHandler(
    (err: unknown, request: FastifyRequest, reply: FastifyReply) => {
      fastify.log.error(err);
      let finalErr;
      if (err instanceof BaseError) {
        finalErr = err;
      } else if (
        (err as FastifyError).validation ||
        (err as Error).name === "BadRequestError" ||
        // Fastify client-errors like FST_ERR_CTP_EMPTY_JSON_BODY carry a
        // statusCode but no `validation` property - surface them as 400s
        // instead of the generic 500.
        (err as FastifyError).statusCode === 400
      ) {
        finalErr = new ValidationError({
          message: (err as FastifyError).message,
        });
      }
      if (finalErr && finalErr instanceof BaseError) {
        request.log.error(
          { errId: finalErr.id, errName: finalErr.name },
          finalErr.toString(),
        );
      } else if (err instanceof Error) {
        request.log.error(err);
        request.log.error(
          { errName: err.name, errMessage: err.message },
          "Native unhandled error: response sent to client.",
        );
      } else {
        request.log.error(`Native unhandled error: response sent to client`);
      }
      if (!finalErr) {
        finalErr = new InternalServerError();
      }
      reply.status(finalErr.httpStatusCode).type("application/json").send({
        error: true,
        name: finalErr.name,
        id: finalErr.id,
        message: finalErr.message,
      });
    },
  );
  fastify.setNotFoundHandler(
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (
        request.raw.url &&
        !request.raw.url.replace(config.BASE_URL, "").startsWith("/api")
      ) {
        try {
          const path = resolve(import.meta.dirname, "../../dist/ui/");
          await reply.sendFile("index.html", path);
        } catch (err) {
          fastify.log.error(err);
          throw new InternalServerError({ message: "Failed to render html" });
        }
      } else {
        throw new NotFoundError({ endpointName: request.url });
      }
    },
  );
});

export default errorHandlerPlugin;
