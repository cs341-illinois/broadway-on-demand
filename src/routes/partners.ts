import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { FastifyZodOpenApiTypeProvider } from "fastify-zod-openapi";
import { Role } from "../generated/prisma/client.js";
import {
  BaseError,
  DatabaseInsertError,
  ValidationError,
} from "../errors/index.js";
import {
  myPartnerGroupResponse,
  partnerGroupEntry,
  PartnerGroupEntry,
  partnersForPeriodResponse,
  putSectionGroupsBodySchema,
  regenerateSectionBodySchema,
} from "../types/partners.js";
import {
  generateRandomGroups,
  getGroupForStudent,
  getPartnerRotationPeriodIndex,
} from "../functions/partners.js";

const periodIndexParams = z.object({
  courseId: z.string().min(1),
  periodIndex: z.coerce.number().int().min(0),
});

function toEntry(group: {
  id: string;
  labSection: string;
  periodIndex: number;
  createdBy: string;
  members: { netId: string; Users: { name: string | null } }[];
}): PartnerGroupEntry {
  return {
    id: group.id,
    labSection: group.labSection,
    periodIndex: group.periodIndex,
    createdBy: group.createdBy,
    members: group.members.map((m) => ({ netId: m.netId, name: m.Users.name })),
  };
}

const partnerRoutes: FastifyPluginAsync = async (fastify, _options) => {
  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().get(
    "/:courseId/currentPeriod",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.STAFF,
          Role.ADMIN,
        ]);
      },
      schema: {
        params: z.object({ courseId: z.string().min(1) }),
        response: { 200: z.object({ periodIndex: z.number().int().min(0) }) },
      },
    },
    async (request, reply) => {
      const { courseId } = request.params;
      const { firstLabDate } = await fastify.prismaClient.course.findFirstOrThrow({
        where: { id: courseId },
        select: { firstLabDate: true },
      });
      const periodIndex = getPartnerRotationPeriodIndex({
        firstLabDate,
        date: new Date(),
      });
      return reply.status(200).send({ periodIndex });
    },
  );

  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().get(
    "/:courseId/period/:periodIndex",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.STAFF,
          Role.ADMIN,
        ]);
      },
      schema: {
        params: periodIndexParams,
        response: { 200: partnersForPeriodResponse },
      },
    },
    async (request, reply) => {
      const { courseId, periodIndex } = request.params;
      const groups = await fastify.prismaClient.partnerGroup.findMany({
        where: { courseId, periodIndex },
        include: { members: { include: { Users: { select: { name: true } } } } },
        orderBy: [{ labSection: "asc" }, { createdAt: "asc" }],
      });
      const groupedNetIds = new Set(
        groups.flatMap((g) => g.members.map((m) => m.netId)),
      );
      const students = await fastify.prismaClient.users.findMany({
        where: {
          courseId,
          role: Role.STUDENT,
          enabled: true,
          labSection: { not: null },
        },
        select: { netId: true, labSection: true },
      });
      const ungroupedNetIds = students
        .map((s) => s.netId)
        .filter((netId) => !groupedNetIds.has(netId));
      const sections = [
        ...new Set(students.map((s) => s.labSection as string)),
      ].sort();

      return reply.status(200).send({
        periodIndex,
        sections,
        groups: groups.map(toEntry),
        ungroupedNetIds,
      });
    },
  );

  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().put(
    "/:courseId/period/:periodIndex/section",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.STAFF,
          Role.ADMIN,
        ]);
      },
      schema: {
        params: periodIndexParams,
        body: putSectionGroupsBodySchema,
        response: { 200: z.array(partnerGroupEntry) },
      },
    },
    async (request, reply) => {
      const { courseId, periodIndex } = request.params;
      const { labSection, groups } = request.body;
      const staffNetId = request.session.user!.email.replace(
        "@illinois.edu",
        "",
      );

      const allNetIds = groups.flat();
      if (new Set(allNetIds).size !== allNetIds.length) {
        throw new ValidationError({
          message: "A student cannot appear in more than one group.",
        });
      }

      const students = await fastify.prismaClient.users.findMany({
        where: {
          courseId,
          netId: { in: allNetIds },
          role: Role.STUDENT,
          enabled: true,
        },
        select: { netId: true, labSection: true },
      });
      const studentsByNetId = new Map(students.map((s) => [s.netId, s]));
      for (const netId of allNetIds) {
        const student = studentsByNetId.get(netId);
        if (!student) {
          throw new ValidationError({
            message: `${netId} is not an enabled student in this course.`,
          });
        }
        if (student.labSection !== labSection) {
          throw new ValidationError({
            message: `${netId} is not in lab section ${labSection}.`,
          });
        }
      }

      const created = await fastify.prismaClient
        .$transaction(async (tx) => {
          await tx.partnerGroup.deleteMany({
            where: { courseId, labSection, periodIndex },
          });
          const result = [];
          for (const memberNetIds of groups) {
            result.push(
              await tx.partnerGroup.create({
                data: {
                  courseId,
                  labSection,
                  periodIndex,
                  createdBy: staffNetId,
                  members: {
                    create: memberNetIds.map((netId) => ({
                      courseId,
                      netId,
                      periodIndex,
                    })),
                  },
                },
                include: { members: { include: { Users: { select: { name: true } } } } },
              }),
            );
          }
          return result;
        })
        .catch((e) => {
          if (e instanceof BaseError) throw e;
          request.log.error(e);
          throw new DatabaseInsertError({
            message: "Could not save partner groups.",
          });
        });

      return reply.status(200).send(created.map(toEntry));
    },
  );

  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().post(
    "/:courseId/period/:periodIndex/section/regenerate",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.ADMIN,
        ]);
      },
      schema: {
        params: periodIndexParams,
        body: regenerateSectionBodySchema,
        response: { 200: z.array(partnerGroupEntry) },
      },
    },
    async (request, reply) => {
      const { courseId, periodIndex } = request.params;
      const { labSection } = request.body;
      const adminNetId = request.session.user!.email.replace(
        "@illinois.edu",
        "",
      );

      const sectionNetIds = (
        await fastify.prismaClient.users.findMany({
          where: { courseId, role: Role.STUDENT, enabled: true, labSection },
          select: { netId: true },
        })
      ).map((s) => s.netId);
      if (sectionNetIds.length === 0) {
        throw new ValidationError({
          message: `No enabled students found in lab section ${labSection}.`,
        });
      }

      const created = await fastify.prismaClient
        .$transaction(async (tx) => {
          await tx.partnerGroup.deleteMany({
            where: { courseId, labSection, periodIndex },
          });
          const result = [];
          for (const memberNetIds of generateRandomGroups(sectionNetIds)) {
            result.push(
              await tx.partnerGroup.create({
                data: {
                  courseId,
                  labSection,
                  periodIndex,
                  createdBy: adminNetId,
                  members: {
                    create: memberNetIds.map((netId) => ({
                      courseId,
                      netId,
                      periodIndex,
                    })),
                  },
                },
                include: { members: { include: { Users: { select: { name: true } } } } },
              }),
            );
          }
          return result;
        })
        .catch((e) => {
          if (e instanceof BaseError) throw e;
          request.log.error(e);
          throw new DatabaseInsertError({
            message: "Could not regenerate partner groups.",
          });
        });

      return reply.status(200).send(created.map(toEntry));
    },
  );

  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().get(
    "/:courseId/me",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.STUDENT,
          Role.STAFF,
          Role.ADMIN,
        ]);
      },
      schema: {
        params: z.object({ courseId: z.string().min(1) }),
        response: { 200: myPartnerGroupResponse },
      },
    },
    async (request, reply) => {
      const { courseId } = request.params;
      const netId = request.session.user!.email.replace("@illinois.edu", "");

      const [{ firstLabDate }, user] = await Promise.all([
        fastify.prismaClient.course.findFirstOrThrow({
          where: { id: courseId },
          select: { firstLabDate: true },
        }),
        fastify.prismaClient.users.findUnique({
          where: { netId_courseId: { netId, courseId } },
          select: { labSection: true },
        }),
      ]);
      const periodIndex = getPartnerRotationPeriodIndex({
        firstLabDate,
        date: new Date(),
      });
      const group = await getGroupForStudent({
        tx: fastify.prismaClient,
        courseId,
        netId,
        periodIndex,
      });

      return reply.status(200).send({
        periodIndex,
        labSection: user?.labSection ?? null,
        group: group
          ? {
              id: group.id,
              members: group.members.map((m) => ({
                netId: m.netId,
                name: m.Users.name,
              })),
            }
          : null,
      });
    },
  );
};

export default partnerRoutes;
