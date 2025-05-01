import { FastifyPluginAsync } from "fastify";
import { Category, JobType, Role } from "@prisma/client";
import { z } from "zod";
import { createAssignment } from "../functions/assignment.js";
import { FastifyZodOpenApiTypeProvider } from "fastify-zod-openapi";
import {
  assignmentResponseBody,
  AssignmentVisibility,
  AutogradableCategory,
  courseResponseBody,
  createAssignmentBodySchema,
} from "../types/assignment.js";
import { BaseError, DatabaseInsertError } from "../errors/index.js";
import { getCourseRoles } from "../functions/userData.js";

const courseRoutes: FastifyPluginAsync = async (fastify, _options) => {
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
          200: courseResponseBody,
        },
      },
    },
    async (request, reply) => {
      const { courseId } = request.params;
      const { name } = await fastify.prismaClient.course.findFirstOrThrow({
        where: { id: courseId },
        select: { name: true },
      });
      const courseRoles = getCourseRoles(courseId, request.session.user.roles);
      const canSeeInvisible =
        courseRoles.includes(Role.ADMIN) || courseRoles.includes(Role.STAFF);
      const assignments = await fastify.prismaClient.assignment.findMany({
        where: {
          courseId,
          ...(canSeeInvisible
            ? {}
            : {
                visibility: {
                  not: AssignmentVisibility.INVISIBLE_FORCE_CLOSE,
                },
              }),
          category: {
            in: [AutogradableCategory.LAB, AutogradableCategory.MP],
          },
        },
        orderBy: {
          openAt: "desc",
        },
      });

      const finalGradingRunIds = assignments
        .map((a) => a.finalGradingRunId)
        .filter((id): id is string => !!id);

      const finalJobs = await fastify.prismaClient.job.findMany({
        where: {
          id: { in: finalGradingRunIds },
        },
        select: {
          id: true,
          dueAt: true,
        },
      });

      const jobsById = Object.fromEntries(
        finalJobs.map((job) => [job.id, job]),
      );

      const assignmentsWithDueDates = assignments
        .filter((assignment) => assignment.finalGradingRunId)
        .map((assignment) => ({
          ...assignment,
          finalGradingRunId: undefined,
          createdAt: undefined,
          updatedAt: undefined,
          courseId: undefined,
          category: assignment.category as AutogradableCategory,
          dueAt: jobsById[assignment.finalGradingRunId!]?.dueAt,
        }));

      reply.send({ name, assignments: assignmentsWithDueDates });
    },
  );
  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().post(
    "/:courseId/assignment",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.STAFF,
          Role.ADMIN,
        ]);
      },
      schema: {
        body: createAssignmentBodySchema,
        params: z.object({ courseId: z.string().min(1) }),
      },
    },
    async (request, reply) => {
      const { courseId } = request.params;
      const {
        name,
        id,
        visibility,
        quotaPeriod,
        quotaAmount,
        openAt,
        dueAt,
        category,
      } = request.body;
      try {
        await createAssignment({
          client: fastify.prismaClient,
          courseId,
          assignmentId: id,
          name,
          visibility,
          quotaAmount,
          quotaPeriod,
          openAt,
          dueAt,
          category,
        });
        reply.status(201).send();
      } catch (e) {
        if (e instanceof BaseError) {
          throw e;
        }
        fastify.log.error(e);
        throw new DatabaseInsertError({
          message: "Could not create assignment.",
        });
      }
    },
  );
  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().get(
    "/:courseId/assignment/:assignmentId",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.STAFF,
          Role.ADMIN,
          Role.STUDENT,
        ]);
      },
      schema: {
        params: z.object({
          courseId: z.string().min(1),
          assignmentId: z.string().min(1),
        }),
        response: {
          200: assignmentResponseBody,
        },
      },
    },
    async (request, reply) => {
      const { courseId, assignmentId } = request.params;
      const courseRoles = getCourseRoles(courseId, request.session.user.roles);
      const { name: courseName } =
        await fastify.prismaClient.course.findFirstOrThrow({
          where: { id: courseId },
          select: { name: true },
        });
      const { name: assignmentName } =
        await fastify.prismaClient.assignment.findFirstOrThrow({
          where: { id: assignmentId, courseId: courseId },
          select: { name: true },
        });
      const isStaff =
        courseRoles.includes(Role.ADMIN) || courseRoles.includes(Role.STAFF);
      const studentRuns = await fastify.prismaClient.job.findMany({
        where: {
          courseId: courseId,
          assignmentId: assignmentId,
          type: JobType.STUDENT_INITIATED,
          JobUser: {
            some: {
              netId: request.session.user.email.replace("@illinois.edu", ""),
            },
          },
        },
        select: {
          id: true,
          status: true,
          dueAt: true,
        },
      });

      reply.send({ isStaff, courseName, assignmentName, studentRuns });
    },
  );
};

export default courseRoutes;
