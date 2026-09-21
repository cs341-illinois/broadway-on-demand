import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { FastifyZodOpenApiTypeProvider } from "fastify-zod-openapi";
import { Role } from "../generated/prisma/client.js";
import { BaseError, ConflictError, DatabaseInsertError, ValidationError } from "../errors/index.js";
import {
  myPartnerGroupResponse,
  partnerGroupEntry,
  PartnerGroupEntry,
  partnersForRoundResponse,
  putSectionGroupsBodySchema,
  sectionRoundHistoryResponse,
  studentPartnerHistoryResponse,
} from "../types/partners.js";
import {
  archiveAndCreateGroups,
  generateRandomGroups,
  getGroupForStudent,
  getPreviousPartnerPairs,
  getSectionRoundHistory,
  getStudentPartnerHistory,
  hasActiveGroups,
} from "../functions/partners.js";
import { PARTNER_MAX_ROUNDS } from "../constants.js";
import { netIdSchema } from "../types/index.js";

const roundParams = z.object({
  courseId: z.string().min(1),
  roundNumber: z.coerce.number().int().min(1).max(PARTNER_MAX_ROUNDS),
});

const roundSectionParams = roundParams.extend({
  labSection: z.string().min(1),
});

function sessionNetId(request: { session: { user?: { email: string } } }): string {
  return request.session.user!.email.replace("@illinois.edu", "");
}

function toEntry(group: {
  id: string;
  labSection: string;
  roundNumber: number;
  createdBy: string;
  createdAt: Date;
  archivedAt: Date | null;
  archivedBy: string | null;
  members: { netId: string; Users: { name: string | null } }[];
}): PartnerGroupEntry {
  return {
    id: group.id,
    labSection: group.labSection,
    roundNumber: group.roundNumber,
    createdBy: group.createdBy,
    createdAt: group.createdAt.toISOString(),
    archivedAt: group.archivedAt ? group.archivedAt.toISOString() : null,
    archivedBy: group.archivedBy,
    members: group.members.map((m) => ({ netId: m.netId, name: m.Users.name })),
  };
}

const partnerRoutes: FastifyPluginAsync = async (fastify, _options) => {
  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().get(
    "/:courseId/round/:roundNumber",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.STAFF,
          Role.ADMIN,
        ]);
      },
      schema: {
        params: roundParams,
        response: { 200: partnersForRoundResponse },
      },
    },
    async (request, reply) => {
      const { courseId, roundNumber } = request.params;
      const groups = await fastify.prismaClient.partnerGroup.findMany({
        where: { courseId, roundNumber, archivedAt: null },
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
        roundNumber,
        sections,
        groups: groups.map(toEntry),
        ungroupedNetIds,
      });
    },
  );

  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().post(
    "/:courseId/round/:roundNumber/section/:labSection/generate",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.ADMIN,
        ]);
      },
      schema: {
        params: roundSectionParams,
        response: { 200: z.array(partnerGroupEntry) },
      },
    },
    async (request, reply) => {
      const { courseId, roundNumber, labSection } = request.params;
      const actorNetId = sessionNetId(request);

      const alreadyActive = await hasActiveGroups({
        tx: fastify.prismaClient,
        courseId,
        labSection,
        roundNumber,
      });
      if (alreadyActive) {
        throw new ConflictError({
          message: `Section ${labSection} already has active groups for round ${roundNumber}. Use regenerate instead.`,
        });
      }

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

      const previousPairs = await getPreviousPartnerPairs({
        tx: fastify.prismaClient,
        courseId,
        labSection,
        roundNumber,
      });
      const created = await fastify.prismaClient
        .$transaction((tx) =>
          archiveAndCreateGroups({
            tx,
            courseId,
            labSection,
            roundNumber,
            groupsOfNetIds: generateRandomGroups(sectionNetIds, previousPairs),
            actorNetId,
          }),
        )
        .catch((e) => {
          if (e instanceof BaseError) throw e;
          request.log.error(e);
          throw new DatabaseInsertError({ message: "Could not generate partner groups." });
        });

      return reply.status(200).send(created.map(toEntry));
    },
  );

  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().post(
    "/:courseId/round/:roundNumber/section/:labSection/regenerate",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.ADMIN,
        ]);
      },
      schema: {
        params: roundSectionParams,
        response: { 200: z.array(partnerGroupEntry) },
      },
    },
    async (request, reply) => {
      const { courseId, roundNumber, labSection } = request.params;
      const actorNetId = sessionNetId(request);

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

      const previousPairs = await getPreviousPartnerPairs({
        tx: fastify.prismaClient,
        courseId,
        labSection,
        roundNumber,
      });
      const created = await fastify.prismaClient
        .$transaction((tx) =>
          archiveAndCreateGroups({
            tx,
            courseId,
            labSection,
            roundNumber,
            groupsOfNetIds: generateRandomGroups(sectionNetIds, previousPairs),
            actorNetId,
          }),
        )
        .catch((e) => {
          if (e instanceof BaseError) throw e;
          request.log.error(e);
          throw new DatabaseInsertError({ message: "Could not regenerate partner groups." });
        });

      return reply.status(200).send(created.map(toEntry));
    },
  );

  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().put(
    "/:courseId/round/:roundNumber/section/:labSection",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.STAFF,
          Role.ADMIN,
        ]);
      },
      schema: {
        params: roundSectionParams,
        body: putSectionGroupsBodySchema,
        response: { 200: z.array(partnerGroupEntry) },
      },
    },
    async (request, reply) => {
      const { courseId, roundNumber, labSection } = request.params;
      const { groups } = request.body;
      const actorNetId = sessionNetId(request);

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
        .$transaction((tx) =>
          archiveAndCreateGroups({
            tx,
            courseId,
            labSection,
            roundNumber,
            groupsOfNetIds: groups,
            actorNetId,
          }),
        )
        .catch((e) => {
          if (e instanceof BaseError) throw e;
          request.log.error(e);
          throw new DatabaseInsertError({ message: "Could not save partner groups." });
        });

      return reply.status(200).send(created.map(toEntry));
    },
  );

  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().get(
    "/:courseId/round/:roundNumber/section/:labSection/history",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.ADMIN,
        ]);
      },
      schema: {
        params: roundSectionParams,
        response: { 200: sectionRoundHistoryResponse },
      },
    },
    async (request, reply) => {
      const { courseId, roundNumber, labSection } = request.params;
      const history = await getSectionRoundHistory({
        tx: fastify.prismaClient,
        courseId,
        labSection,
        roundNumber,
      });
      return reply.status(200).send(history.map(toEntry));
    },
  );

  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().get(
    "/:courseId/student/:netId/history",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.ADMIN,
        ]);
      },
      schema: {
        params: z.object({ courseId: z.string().min(1), netId: netIdSchema }),
        response: { 200: studentPartnerHistoryResponse },
      },
    },
    async (request, reply) => {
      const { courseId, netId } = request.params;
      const history = await getStudentPartnerHistory({
        tx: fastify.prismaClient,
        courseId,
        netId,
      });
      return reply.status(200).send(history.map(toEntry));
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
      const netId = sessionNetId(request);

      const user = await fastify.prismaClient.users.findUnique({
        where: { netId_courseId: { netId, courseId } },
        select: { labSection: true },
      });

      const rounds = await Promise.all(
        Array.from({ length: PARTNER_MAX_ROUNDS }, (_, i) => i + 1).map(
          async (roundNumber) => {
            const group = await getGroupForStudent({
              tx: fastify.prismaClient,
              courseId,
              netId,
              roundNumber,
            });
            return {
              roundNumber,
              group: group
                ? {
                    id: group.id,
                    members: group.members.map((m) => ({
                      netId: m.netId,
                      name: m.Users.name,
                    })),
                  }
                : null,
            };
          },
        ),
      );

      return reply.status(200).send({
        labSection: user?.labSection ?? null,
        rounds,
      });
    },
  );
};

export default partnerRoutes;
