import { Prisma, PrismaClient, Role } from "../generated/prisma/client.js";
import { type RedisClientType } from "redis";
import { type FastifyBaseLogger } from "fastify";
import {
  ConflictError,
  UnauthorizedError,
  ValidationError,
} from "../errors/index.js";
import {
  CLINIC_MAX_BLOCK_HOURS,
  CLINIC_SLOT_MINUTES,
  CLINIC_STUDENT_CANCEL_CUTOFF_HOURS,
} from "../constants.js";
import {
  cancelClinicEvent,
  createClinicEvent,
  getOutlookStatus,
} from "./outlook.js";
import { type CalendarSyncResponse, type ClinicPerson } from "../types/clinics.js";

type Tx = PrismaClient | Prisma.TransactionClient;

const SLOT_MS = CLINIC_SLOT_MINUTES * 60 * 1000;

export function netIdToEmail(netId: string) {
  return `${netId}@illinois.edu`;
}

function isUniqueViolation(e: unknown) {
  return (
    e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002"
  );
}

export async function getClinicOrThrow({
  tx,
  courseId,
  clinicId,
}: {
  tx: Tx;
  courseId: string;
  clinicId: string;
}) {
  const clinic = await tx.interviewClinic.findFirst({
    where: { id: clinicId, courseId },
  });
  if (!clinic) {
    throw new ValidationError({ message: "Interview clinic not found." });
  }
  return clinic;
}

export function isSignupOpen(clinic: {
  archivedAt: Date | null;
  signupOpensAt: Date | null;
}) {
  return (
    !clinic.archivedAt &&
    (!clinic.signupOpensAt || clinic.signupOpensAt.getTime() <= Date.now())
  );
}

export function canStudentCancel(slotStartAt: Date) {
  return (
    slotStartAt.getTime() - Date.now() >=
    CLINIC_STUDENT_CANCEL_CUTOFF_HOURS * 60 * 60 * 1000
  );
}

// Looks up display names for netIds enrolled in the course.
export async function getNames({
  tx,
  courseId,
  netIds,
}: {
  tx: Tx;
  courseId: string;
  netIds: string[];
}): Promise<Map<string, string | null>> {
  if (netIds.length === 0) return new Map();
  const users = await tx.users.findMany({
    where: { courseId, netId: { in: [...new Set(netIds)] } },
    select: { netId: true, name: true },
  });
  return new Map(users.map((u) => [u.netId, u.name]));
}

export function toPerson(
  netId: string,
  names: Map<string, string | null>,
): ClinicPerson {
  return { netId, name: names.get(netId) ?? null };
}

// A student's project team is everyone holding the same active repo for the
// clinic's projectKey.
export async function getTeamForStudent({
  tx,
  courseId,
  projectKey,
  netId,
}: {
  tx: Tx;
  courseId: string;
  projectKey: string;
  netId: string;
}): Promise<{ repoName: string; members: ClinicPerson[] } | null> {
  const mine = await tx.projectRepoAssignment.findFirst({
    where: { courseId, projectKey, netId, releasedAt: null },
    select: { repoName: true },
  });
  if (!mine) return null;
  const rows = await tx.projectRepoAssignment.findMany({
    where: {
      courseId,
      projectKey,
      repoName: mine.repoName,
      releasedAt: null,
      Users: { role: Role.STUDENT, enabled: true },
    },
    select: { netId: true, Users: { select: { name: true } } },
    orderBy: { netId: "asc" },
  });
  return {
    repoName: mine.repoName,
    members: rows.map((r) => ({ netId: r.netId, name: r.Users.name })),
  };
}

export async function createRoomBlock({
  tx,
  courseId,
  clinicId,
  room,
  startAt,
  endAt,
  actor,
}: {
  tx: Prisma.TransactionClient;
  courseId: string;
  clinicId: string;
  room: string;
  startAt: Date;
  endAt: Date;
  actor: string;
}) {
  const clinic = await getClinicOrThrow({ tx, courseId, clinicId });
  if (clinic.archivedAt) {
    throw new ValidationError({ message: "This clinic is archived." });
  }
  if (startAt.getTime() % SLOT_MS !== 0 || endAt.getTime() % SLOT_MS !== 0) {
    throw new ValidationError({
      message: `Start and end times must fall on ${CLINIC_SLOT_MINUTES}-minute boundaries.`,
    });
  }
  if (endAt <= startAt) {
    throw new ValidationError({ message: "End time must be after start time." });
  }
  if (endAt.getTime() - startAt.getTime() > CLINIC_MAX_BLOCK_HOURS * 3600000) {
    throw new ValidationError({
      message: `A room booking cannot be longer than ${CLINIC_MAX_BLOCK_HOURS} hours.`,
    });
  }
  const overlapping = await tx.clinicRoomBlock.findFirst({
    where: {
      room: { equals: room, mode: "insensitive" },
      startAt: { lt: endAt },
      endAt: { gt: startAt },
      InterviewClinic: { courseId, archivedAt: null },
    },
    select: { id: true },
  });
  if (overlapping) {
    throw new ConflictError({
      message: `${room} is already entered for an overlapping time.`,
    });
  }
  const block = await tx.clinicRoomBlock.create({
    data: { clinicId, room, startAt, endAt, createdBy: actor },
  });
  const slots = [];
  for (let t = startAt.getTime(); t < endAt.getTime(); t += SLOT_MS) {
    slots.push({
      clinicId,
      roomBlockId: block.id,
      startAt: new Date(t),
      endAt: new Date(t + SLOT_MS),
    });
  }
  await tx.clinicSlot.createMany({ data: slots });
  return block;
}

export async function deleteRoomBlock({
  tx,
  courseId,
  clinicId,
  blockId,
}: {
  tx: Prisma.TransactionClient;
  courseId: string;
  clinicId: string;
  blockId: string;
}) {
  await getClinicOrThrow({ tx, courseId, clinicId });
  const block = await tx.clinicRoomBlock.findFirst({
    where: { id: blockId, clinicId },
    select: { id: true },
  });
  if (!block) {
    throw new ValidationError({ message: "Room booking not found." });
  }
  const activeBookings = await tx.clinicBooking.count({
    where: { ClinicSlot: { roomBlockId: blockId }, cancelledAt: null },
  });
  if (activeBookings > 0) {
    throw new ConflictError({
      message: `This room booking has ${activeBookings} active team booking(s). Cancel them first.`,
    });
  }
  await tx.clinicRoomBlock.delete({ where: { id: blockId } });
}

async function lockSlot(
  tx: Prisma.TransactionClient,
  clinicId: string,
  slotId: string,
) {
  await tx.$queryRaw`SELECT id FROM "ClinicSlot" WHERE id = ${slotId} FOR UPDATE`;
  const slot = await tx.clinicSlot.findFirst({
    where: { id: slotId, clinicId },
    include: { bookings: { where: { cancelledAt: null }, select: { id: true } } },
  });
  if (!slot) {
    throw new ValidationError({ message: "Slot not found." });
  }
  return slot;
}

export async function claimSlot({
  prismaClient,
  courseId,
  clinicId,
  slotId,
  caNetId,
}: {
  prismaClient: PrismaClient;
  courseId: string;
  clinicId: string;
  slotId: string;
  caNetId: string;
}) {
  const outlook = await getOutlookStatus(prismaClient, caNetId);
  if (!outlook.configured) {
    throw new ValidationError({
      message: "Outlook integration is not configured on this server.",
    });
  }
  if (!outlook.connected) {
    throw new ValidationError({
      message: "Connect your Outlook calendar before claiming clinic slots.",
    });
  }
  await prismaClient.$transaction(async (tx) => {
    const clinic = await getClinicOrThrow({ tx, courseId, clinicId });
    if (clinic.archivedAt) {
      throw new ValidationError({ message: "This clinic is archived." });
    }
    const slot = await lockSlot(tx, clinicId, slotId);
    if (slot.startAt.getTime() <= Date.now()) {
      throw new ValidationError({ message: "This slot has already started." });
    }
    if (slot.caNetId === caNetId) return;
    if (slot.caNetId) {
      throw new ConflictError({
        message: `This slot is already covered by ${slot.caNetId}.`,
      });
    }
    await tx.clinicSlot.update({
      where: { id: slotId },
      data: { caNetId, claimedAt: new Date() },
    });
  });
}

export async function unclaimSlot({
  prismaClient,
  courseId,
  clinicId,
  slotId,
  actor,
  isAdmin,
}: {
  prismaClient: PrismaClient;
  courseId: string;
  clinicId: string;
  slotId: string;
  actor: string;
  isAdmin: boolean;
}) {
  await prismaClient.$transaction(async (tx) => {
    await getClinicOrThrow({ tx, courseId, clinicId });
    const slot = await lockSlot(tx, clinicId, slotId);
    if (!slot.caNetId) return;
    if (slot.caNetId !== actor && !isAdmin) {
      throw new UnauthorizedError({
        message: "You can only release slots you have claimed.",
      });
    }
    if (slot.bookings.length > 0) {
      throw new ConflictError({
        message:
          "A team has booked this slot. Cancel the booking before releasing it.",
      });
    }
    await tx.clinicSlot.update({
      where: { id: slotId },
      data: { caNetId: null, claimedAt: null },
    });
  });
}

export async function bookSlot({
  prismaClient,
  courseId,
  clinicId,
  slotId,
  netId,
}: {
  prismaClient: PrismaClient;
  courseId: string;
  clinicId: string;
  slotId: string;
  netId: string;
}) {
  try {
    return await prismaClient.$transaction(async (tx) => {
      const clinic = await getClinicOrThrow({ tx, courseId, clinicId });
      if (!isSignupOpen(clinic)) {
        throw new ValidationError({
          message: "Signups for this clinic are not open.",
        });
      }
      const team = await getTeamForStudent({
        tx,
        courseId,
        projectKey: clinic.projectKey,
        netId,
      });
      if (!team) {
        throw new ValidationError({
          message: `You are not on a team for ${clinic.projectKey}.`,
        });
      }
      const slot = await lockSlot(tx, clinicId, slotId);
      if (!slot.caNetId) {
        throw new ValidationError({
          message: "This slot is not being offered.",
        });
      }
      if (slot.startAt.getTime() <= Date.now()) {
        throw new ValidationError({ message: "This slot has already started." });
      }
      if (slot.bookings.length > 0) {
        throw new ConflictError({
          message: "This slot was just taken. Please pick another one.",
        });
      }
      const existing = await tx.clinicBooking.findFirst({
        where: { clinicId, repoName: team.repoName, cancelledAt: null },
        select: { id: true },
      });
      if (existing) {
        throw new ConflictError({
          message:
            "Your team already has a booking for this clinic. Cancel it first to pick a different slot.",
        });
      }
      return tx.clinicBooking.create({
        data: {
          clinicId,
          slotId,
          projectKey: clinic.projectKey,
          repoName: team.repoName,
          attendeeNetIds: team.members.map((m) => m.netId),
          bookedBy: netId,
          organizerNetId: slot.caNetId,
        },
      });
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new ConflictError({
        message:
          "This slot or your team's booking changed while you were booking. Please refresh and try again.",
      });
    }
    throw e;
  }
}

export async function cancelBooking({
  prismaClient,
  courseId,
  clinicId,
  bookingId,
  actor,
  isStaff,
}: {
  prismaClient: PrismaClient;
  courseId: string;
  clinicId: string;
  bookingId: string;
  actor: string;
  isStaff: boolean;
}) {
  await prismaClient.$transaction(async (tx) => {
    const clinic = await getClinicOrThrow({ tx, courseId, clinicId });
    const booking = await tx.clinicBooking.findFirst({
      where: { id: bookingId, clinicId, cancelledAt: null },
      include: { ClinicSlot: { select: { startAt: true } } },
    });
    if (!booking) {
      throw new ValidationError({ message: "Booking not found." });
    }
    if (!isStaff) {
      const team = await getTeamForStudent({
        tx,
        courseId,
        projectKey: clinic.projectKey,
        netId: actor,
      });
      if (team?.repoName !== booking.repoName) {
        throw new UnauthorizedError({
          message: "You can only cancel your own team's booking.",
        });
      }
      if (!canStudentCancel(booking.ClinicSlot.startAt)) {
        throw new UnauthorizedError({
          message: `Bookings can only be cancelled more than ${CLINIC_STUDENT_CANCEL_CUTOFF_HOURS} hours in advance. Please contact course staff.`,
        });
      }
    }
    await tx.clinicBooking.update({
      where: { id: bookingId },
      data: {
        cancelledAt: new Date(),
        cancelledBy: actor,
        // Nothing to cancel in Outlook if the invite was never sent.
        ...(booking.outlookEventId
          ? {}
          : { calendarStatus: "CANCELLED", calendarError: null }),
      },
    });
  });
}

// Brings the Outlook event in line with the booking: creates it for an active
// booking without one, or cancels it for a cancelled booking. Never throws;
// failures are recorded on the booking so staff can retry.
export async function syncBookingCalendar({
  prismaClient,
  redisClient,
  bookingId,
  logger,
}: {
  prismaClient: PrismaClient;
  redisClient: RedisClientType;
  bookingId: string;
  logger: FastifyBaseLogger;
}): Promise<CalendarSyncResponse> {
  const booking = await prismaClient.clinicBooking.findUniqueOrThrow({
    where: { id: bookingId },
    include: {
      InterviewClinic: true,
      ClinicSlot: { include: { ClinicRoomBlock: true } },
    },
  });
  const clinic = booking.InterviewClinic;
  const slot = booking.ClinicSlot;
  const organizerNetId = booking.organizerNetId ?? slot.caNetId;

  const record = async (data: Prisma.ClinicBookingUpdateInput) => {
    const updated = await prismaClient.clinicBooking.update({
      where: { id: bookingId },
      data,
      select: { calendarStatus: true, calendarError: true },
    });
    return updated;
  };

  try {
    if (booking.cancelledAt) {
      if (!booking.outlookEventId || !organizerNetId) {
        return record({ calendarStatus: "CANCELLED", calendarError: null });
      }
      await cancelClinicEvent({
        prismaClient,
        redisClient,
        organizerNetId,
        eventId: booking.outlookEventId,
        comment: `Your ${clinic.title} slot has been cancelled.`,
        logger,
      });
      return record({ calendarStatus: "CANCELLED", calendarError: null });
    }

    if (booking.outlookEventId) {
      return record({ calendarStatus: "CREATED", calendarError: null });
    }
    if (!organizerNetId) {
      throw new Error("Slot has no CA assigned.");
    }
    const names = await getNames({
      tx: prismaClient,
      courseId: clinic.courseId,
      netIds: [...booking.attendeeNetIds, organizerNetId],
    });
    const caName = names.get(organizerNetId) ?? organizerNetId;
    const memberList = booking.attendeeNetIds
      .map((n) => `<li>${escapeHtml(names.get(n) ?? n)} (${n})</li>`)
      .join("");
    const eventId = await createClinicEvent({
      prismaClient,
      redisClient,
      organizerNetId,
      transactionId: booking.id,
      subject: `${clinic.title}: ${booking.repoName}`,
      bodyHtml:
        `<p>${escapeHtml(clinic.title)} interview for team <b>${escapeHtml(booking.repoName)}</b> with ${escapeHtml(caName)}.</p>` +
        `<p>Location: ${escapeHtml(slot.ClinicRoomBlock.room)}</p>` +
        `<p>Team members:</p><ul>${memberList}</ul>` +
        (clinic.description
          ? `<p>${escapeHtml(clinic.description)}</p>`
          : "") +
        `<p>Students may cancel on Broadway On-Demand up to ${CLINIC_STUDENT_CANCEL_CUTOFF_HOURS} hours before the slot.</p>`,
      startAt: slot.startAt,
      endAt: slot.endAt,
      room: slot.ClinicRoomBlock.room,
      attendees: booking.attendeeNetIds.map((n) => ({
        email: netIdToEmail(n),
        name: names.get(n) ?? null,
      })),
    });
    await record({
      outlookEventId: eventId,
      organizerNetId,
      calendarStatus: "CREATED",
      calendarError: null,
    });
    // The booking may have been cancelled while the invite was being sent.
    const latest = await prismaClient.clinicBooking.findUniqueOrThrow({
      where: { id: bookingId },
      select: { cancelledAt: true },
    });
    if (latest.cancelledAt) {
      return syncBookingCalendar({
        prismaClient,
        redisClient,
        bookingId,
        logger,
      });
    }
    return { calendarStatus: "CREATED", calendarError: null };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error({ err: e, bookingId }, "Clinic Outlook sync failed");
    return record({
      calendarStatus: "FAILED",
      calendarError: booking.cancelledAt
        ? `Cancellation not sent: ${message}`
        : message,
    });
  }
}

function escapeHtml(s: string) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
