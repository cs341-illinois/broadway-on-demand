import { FastifyPluginAsync, FastifyRequest } from "fastify";
import { FastifyZodOpenApiTypeProvider } from "fastify-zod-openapi";
import { z } from "zod";
import { Category, Role } from "../generated/prisma/client.js";
import { ValidationError } from "../errors/index.js";
import { getCourseRoles } from "../functions/userData.js";
import {
  bookSlot,
  cancelBooking,
  canStudentCancel,
  claimSlot,
  createRoomBlock,
  deleteRoomBlock,
  getClinicOrThrow,
  getNames,
  getTeamForStudent,
  isSignupOpen,
  syncBookingCalendar,
  toPerson,
  unclaimSlot,
} from "../functions/clinics.js";
import { getOutlookStatus } from "../functions/outlook.js";
import { CLINIC_STUDENT_CANCEL_CUTOFF_HOURS } from "../constants.js";
import {
  calendarSyncResponse,
  ClinicEntry,
  clinicEntry,
  clinicsListResponse,
  createClinicBody,
  createRoomBlockBody,
  outlookStatusResponse,
  staffClinicViewResponse,
  studentClinicViewResponse,
  updateClinicBody,
} from "../types/clinics.js";

const courseParams = z.object({ courseId: z.string().min(1) });
const clinicParams = courseParams.extend({ clinicId: z.string().min(1) });
const blockParams = clinicParams.extend({ blockId: z.string().min(1) });
const slotParams = clinicParams.extend({ slotId: z.string().min(1) });
const bookingParams = clinicParams.extend({ bookingId: z.string().min(1) });

function sessionNetId(request: { session: { user?: { email: string } } }): string {
  return request.session.user!.email.replace("@illinois.edu", "");
}

function courseRolesOf(request: FastifyRequest, courseId: string) {
  return getCourseRoles(courseId, request.session.user!.roles);
}

function toClinicEntry(clinic: {
  id: string;
  projectKey: string;
  title: string;
  description: string | null;
  signupOpensAt: Date | null;
  archivedAt: Date | null;
  createdAt: Date;
}): ClinicEntry {
  return {
    id: clinic.id,
    projectKey: clinic.projectKey,
    title: clinic.title,
    description: clinic.description,
    signupOpensAt: clinic.signupOpensAt?.toISOString() ?? null,
    archivedAt: clinic.archivedAt?.toISOString() ?? null,
    createdAt: clinic.createdAt.toISOString(),
  };
}

const clinicRoutes: FastifyPluginAsync = async (fastify, _options) => {
  const syncCalendar = (bookingId: string, request: FastifyRequest) =>
    syncBookingCalendar({
      prismaClient: fastify.prismaClient,
      redisClient: fastify.redisClient,
      bookingId,
      logger: request.log,
    });

  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().get(
    "/:courseId",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.STUDENT,
          Role.STAFF,
          Role.ADMIN,
        ]);
      },
      schema: {
        params: courseParams,
        response: { 200: clinicsListResponse },
      },
    },
    async (request, reply) => {
      const { courseId } = request.params;
      const roles = courseRolesOf(request, courseId);
      const isStaff = roles.includes(Role.STAFF) || roles.includes(Role.ADMIN);
      const course = await fastify.prismaClient.course.findUniqueOrThrow({
        where: { id: courseId },
        select: { name: true, courseTimezone: true },
      });
      const clinics = await fastify.prismaClient.interviewClinic.findMany({
        where: { courseId, ...(isStaff ? {} : { archivedAt: null }) },
        orderBy: [{ archivedAt: { sort: "desc", nulls: "first" } }, { createdAt: "desc" }],
      });
      return reply.status(200).send({
        courseName: course.name,
        courseTimezone: course.courseTimezone,
        clinics: clinics.map(toClinicEntry),
      });
    },
  );

  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().post(
    "/:courseId",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.ADMIN,
        ]);
      },
      schema: {
        params: courseParams,
        body: createClinicBody,
        response: { 201: clinicEntry },
      },
    },
    async (request, reply) => {
      const { courseId } = request.params;
      const { projectKey, title, description, signupOpensAt } = request.body;
      const project = await fastify.prismaClient.assignment.findFirst({
        where: { courseId, category: Category.PROJECT, projectKey },
        select: { id: true },
      });
      if (!project) {
        throw new ValidationError({
          message: `${projectKey} is not a project in this course.`,
        });
      }
      const clinic = await fastify.prismaClient.interviewClinic.create({
        data: {
          courseId,
          projectKey,
          title,
          description: description || null,
          signupOpensAt: signupOpensAt ? new Date(signupOpensAt) : null,
          createdBy: sessionNetId(request),
        },
      });
      return reply.status(201).send(toClinicEntry(clinic));
    },
  );

  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().patch(
    "/:courseId/:clinicId",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.ADMIN,
        ]);
      },
      schema: {
        params: clinicParams,
        body: updateClinicBody,
        response: { 200: clinicEntry },
      },
    },
    async (request, reply) => {
      const { courseId, clinicId } = request.params;
      const { title, description, signupOpensAt, archived } = request.body;
      await getClinicOrThrow({ tx: fastify.prismaClient, courseId, clinicId });
      const clinic = await fastify.prismaClient.interviewClinic.update({
        where: { id: clinicId },
        data: {
          ...(title !== undefined ? { title } : {}),
          ...(description !== undefined
            ? { description: description || null }
            : {}),
          ...(signupOpensAt !== undefined
            ? { signupOpensAt: signupOpensAt ? new Date(signupOpensAt) : null }
            : {}),
          ...(archived !== undefined
            ? { archivedAt: archived ? new Date() : null }
            : {}),
        },
      });
      return reply.status(200).send(toClinicEntry(clinic));
    },
  );

  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().get(
    "/:courseId/outlook/status",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.STAFF,
          Role.ADMIN,
        ]);
      },
      schema: {
        params: courseParams,
        response: { 200: outlookStatusResponse },
      },
    },
    async (request, reply) => {
      return reply
        .status(200)
        .send(
          await getOutlookStatus(fastify.prismaClient, sessionNetId(request)),
        );
    },
  );

  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().get(
    "/:courseId/:clinicId/staff",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.STAFF,
          Role.ADMIN,
        ]);
      },
      schema: {
        params: clinicParams,
        response: { 200: staffClinicViewResponse },
      },
    },
    async (request, reply) => {
      const { courseId, clinicId } = request.params;
      const tx = fastify.prismaClient;
      const clinic = await getClinicOrThrow({ tx, courseId, clinicId });
      const blocks = await tx.clinicRoomBlock.findMany({
        where: { clinicId },
        orderBy: [{ startAt: "asc" }, { room: "asc" }],
      });
      const slots = await tx.clinicSlot.findMany({
        where: { clinicId },
        include: {
          ClinicRoomBlock: { select: { room: true } },
          bookings: { where: { cancelledAt: null } },
        },
        orderBy: [{ startAt: "asc" }],
      });
      const failedCancellations = await tx.clinicBooking.findMany({
        where: {
          clinicId,
          cancelledAt: { not: null },
          calendarStatus: "FAILED",
        },
        include: {
          ClinicSlot: {
            select: { startAt: true, ClinicRoomBlock: { select: { room: true } } },
          },
        },
        orderBy: { bookedAt: "asc" },
      });
      const names = await getNames({
        tx,
        courseId,
        netIds: [
          ...slots.flatMap((s) => [
            ...(s.caNetId ? [s.caNetId] : []),
            ...s.bookings.flatMap((b) => b.attendeeNetIds),
          ]),
          ...failedCancellations.flatMap((b) => b.attendeeNetIds),
        ],
      });
      const toBooking = (b: (typeof slots)[number]["bookings"][number]) => ({
        id: b.id,
        repoName: b.repoName,
        attendees: b.attendeeNetIds.map((n) => toPerson(n, names)),
        bookedBy: b.bookedBy,
        bookedAt: b.bookedAt.toISOString(),
        calendarStatus: b.calendarStatus,
        calendarError: b.calendarError,
      });
      return reply.status(200).send({
        clinic: toClinicEntry(clinic),
        blocks: blocks.map((b) => ({
          id: b.id,
          room: b.room,
          startAt: b.startAt.toISOString(),
          endAt: b.endAt.toISOString(),
          createdBy: b.createdBy,
        })),
        slots: slots
          .sort(
            (a, b) =>
              a.startAt.getTime() - b.startAt.getTime() ||
              a.ClinicRoomBlock.room.localeCompare(b.ClinicRoomBlock.room),
          )
          .map((s) => ({
            id: s.id,
            roomBlockId: s.roomBlockId,
            room: s.ClinicRoomBlock.room,
            startAt: s.startAt.toISOString(),
            endAt: s.endAt.toISOString(),
            ca: s.caNetId ? toPerson(s.caNetId, names) : null,
            booking: s.bookings[0] ? toBooking(s.bookings[0]) : null,
          })),
        cancelledWithCalendarErrors: failedCancellations.map((b) => ({
          ...toBooking(b),
          slotStartAt: b.ClinicSlot.startAt.toISOString(),
          room: b.ClinicSlot.ClinicRoomBlock.room,
        })),
      });
    },
  );

  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().get(
    "/:courseId/:clinicId/student",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.STUDENT,
        ]);
      },
      schema: {
        params: clinicParams,
        response: { 200: studentClinicViewResponse },
      },
    },
    async (request, reply) => {
      const { courseId, clinicId } = request.params;
      const netId = sessionNetId(request);
      const tx = fastify.prismaClient;
      const clinic = await getClinicOrThrow({ tx, courseId, clinicId });
      if (clinic.archivedAt) {
        throw new ValidationError({ message: "Interview clinic not found." });
      }
      const team = await getTeamForStudent({
        tx,
        courseId,
        projectKey: clinic.projectKey,
        netId,
      });
      const myBooking = team
        ? await tx.clinicBooking.findFirst({
            where: { clinicId, repoName: team.repoName, cancelledAt: null },
            include: {
              ClinicSlot: { include: { ClinicRoomBlock: { select: { room: true } } } },
            },
          })
        : null;
      const slots = await tx.clinicSlot.findMany({
        where: {
          clinicId,
          caNetId: { not: null },
          startAt: { gt: new Date() },
        },
        include: {
          ClinicRoomBlock: { select: { room: true } },
          bookings: { where: { cancelledAt: null }, select: { id: true } },
        },
        orderBy: [{ startAt: "asc" }],
      });
      const names = await getNames({
        tx,
        courseId,
        netIds: [
          ...slots.map((s) => s.caNetId!),
          ...(myBooking?.organizerNetId ? [myBooking.organizerNetId] : []),
        ],
      });
      return reply.status(200).send({
        clinic: toClinicEntry(clinic),
        signupOpen: isSignupOpen(clinic),
        cancelCutoffHours: CLINIC_STUDENT_CANCEL_CUTOFF_HOURS,
        team,
        myBooking: myBooking
          ? {
              id: myBooking.id,
              room: myBooking.ClinicSlot.ClinicRoomBlock.room,
              startAt: myBooking.ClinicSlot.startAt.toISOString(),
              endAt: myBooking.ClinicSlot.endAt.toISOString(),
              ca: toPerson(myBooking.organizerNetId!, names),
              calendarStatus: myBooking.calendarStatus,
              canCancel: canStudentCancel(myBooking.ClinicSlot.startAt),
            }
          : null,
        slots: slots.map((s) => ({
          id: s.id,
          room: s.ClinicRoomBlock.room,
          startAt: s.startAt.toISOString(),
          endAt: s.endAt.toISOString(),
          ca: toPerson(s.caNetId!, names),
          available: s.bookings.length === 0,
        })),
      });
    },
  );

  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().post(
    "/:courseId/:clinicId/blocks",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.ADMIN,
        ]);
      },
      schema: {
        params: clinicParams,
        body: createRoomBlockBody,
      },
    },
    async (request, reply) => {
      const { courseId, clinicId } = request.params;
      const { room, startAt, endAt } = request.body;
      await fastify.prismaClient.$transaction((tx) =>
        createRoomBlock({
          tx,
          courseId,
          clinicId,
          room,
          startAt: new Date(startAt),
          endAt: new Date(endAt),
          actor: sessionNetId(request),
        }),
      );
      return reply.status(201).send();
    },
  );

  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().delete(
    "/:courseId/:clinicId/blocks/:blockId",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.ADMIN,
        ]);
      },
      schema: { params: blockParams },
    },
    async (request, reply) => {
      const { courseId, clinicId, blockId } = request.params;
      await fastify.prismaClient.$transaction((tx) =>
        deleteRoomBlock({ tx, courseId, clinicId, blockId }),
      );
      return reply.status(204).send();
    },
  );

  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().post(
    "/:courseId/:clinicId/slots/:slotId/claim",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.STAFF,
          Role.ADMIN,
        ]);
      },
      schema: { params: slotParams },
    },
    async (request, reply) => {
      const { courseId, clinicId, slotId } = request.params;
      await claimSlot({
        prismaClient: fastify.prismaClient,
        courseId,
        clinicId,
        slotId,
        caNetId: sessionNetId(request),
      });
      return reply.status(204).send();
    },
  );

  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().delete(
    "/:courseId/:clinicId/slots/:slotId/claim",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.STAFF,
          Role.ADMIN,
        ]);
      },
      schema: { params: slotParams },
    },
    async (request, reply) => {
      const { courseId, clinicId, slotId } = request.params;
      await unclaimSlot({
        prismaClient: fastify.prismaClient,
        courseId,
        clinicId,
        slotId,
        actor: sessionNetId(request),
        isAdmin: courseRolesOf(request, courseId).includes(Role.ADMIN),
      });
      return reply.status(204).send();
    },
  );

  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().post(
    "/:courseId/:clinicId/slots/:slotId/book",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.STUDENT,
        ]);
      },
      schema: {
        params: slotParams,
        response: { 201: calendarSyncResponse },
      },
    },
    async (request, reply) => {
      const { courseId, clinicId, slotId } = request.params;
      const booking = await bookSlot({
        prismaClient: fastify.prismaClient,
        courseId,
        clinicId,
        slotId,
        netId: sessionNetId(request),
      });
      return reply.status(201).send(await syncCalendar(booking.id, request));
    },
  );

  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().post(
    "/:courseId/:clinicId/bookings/:bookingId/cancel",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.STUDENT,
          Role.STAFF,
          Role.ADMIN,
        ]);
      },
      schema: {
        params: bookingParams,
        response: { 200: calendarSyncResponse },
      },
    },
    async (request, reply) => {
      const { courseId, clinicId, bookingId } = request.params;
      const roles = courseRolesOf(request, courseId);
      await cancelBooking({
        prismaClient: fastify.prismaClient,
        courseId,
        clinicId,
        bookingId,
        actor: sessionNetId(request),
        isStaff: roles.includes(Role.STAFF) || roles.includes(Role.ADMIN),
      });
      return reply.status(200).send(await syncCalendar(bookingId, request));
    },
  );

  fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>().post(
    "/:courseId/:clinicId/bookings/:bookingId/retryCalendar",
    {
      onRequest: async (request, reply) => {
        await fastify.authorize(request, reply, request.params.courseId, [
          Role.STAFF,
          Role.ADMIN,
        ]);
      },
      schema: {
        params: bookingParams,
        response: { 200: calendarSyncResponse },
      },
    },
    async (request, reply) => {
      const { courseId, clinicId, bookingId } = request.params;
      await getClinicOrThrow({ tx: fastify.prismaClient, courseId, clinicId });
      const booking = await fastify.prismaClient.clinicBooking.findFirst({
        where: { id: bookingId, clinicId },
        select: { id: true },
      });
      if (!booking) {
        throw new ValidationError({ message: "Booking not found." });
      }
      return reply.status(200).send(await syncCalendar(bookingId, request));
    },
  );
};

export default clinicRoutes;
