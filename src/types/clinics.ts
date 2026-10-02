import { z } from "zod";
import { netIdSchema } from "./index.js";

export const clinicCalendarStatus = z.enum([
  "PENDING",
  "CREATED",
  "FAILED",
  "CANCELLED",
]);

export type ClinicCalendarStatusValue = z.infer<typeof clinicCalendarStatus>;

const isoDateTime = z.string().datetime({ offset: true });

export const clinicEntry = z.object({
  id: z.string().min(1),
  projectKey: z.string().min(1),
  title: z.string().min(1),
  description: z.string().nullable(),
  signupOpensAt: z.string().nullable(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
});

export type ClinicEntry = z.infer<typeof clinicEntry>;

export const clinicsListResponse = z.object({
  courseName: z.string(),
  courseTimezone: z.string(),
  clinics: z.array(clinicEntry),
});

export type ClinicsListResponse = z.infer<typeof clinicsListResponse>;

export const createClinicBody = z.object({
  projectKey: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  signupOpensAt: isoDateTime.nullable().optional(),
});

export type CreateClinicBody = z.infer<typeof createClinicBody>;

export const updateClinicBody = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  signupOpensAt: isoDateTime.nullable().optional(),
  archived: z.boolean().optional(),
});

export type UpdateClinicBody = z.infer<typeof updateClinicBody>;

export const createRoomBlockBody = z.object({
  room: z.string().trim().min(1).max(200),
  startAt: isoDateTime,
  endAt: isoDateTime,
});

export type CreateRoomBlockBody = z.infer<typeof createRoomBlockBody>;

export const clinicPerson = z.object({
  netId: netIdSchema,
  name: z.string().nullable(),
});

export type ClinicPerson = z.infer<typeof clinicPerson>;

export const clinicBookingEntry = z.object({
  id: z.string().min(1),
  repoName: z.string(),
  attendees: z.array(clinicPerson),
  bookedBy: z.string(),
  bookedAt: z.string(),
  calendarStatus: clinicCalendarStatus,
  calendarError: z.string().nullable(),
});

export type ClinicBookingEntry = z.infer<typeof clinicBookingEntry>;

export const clinicRoomBlockEntry = z.object({
  id: z.string().min(1),
  room: z.string(),
  startAt: z.string(),
  endAt: z.string(),
  createdBy: z.string(),
});

export type ClinicRoomBlockEntry = z.infer<typeof clinicRoomBlockEntry>;

export const staffClinicSlotEntry = z.object({
  id: z.string().min(1),
  roomBlockId: z.string().min(1),
  room: z.string(),
  startAt: z.string(),
  endAt: z.string(),
  ca: clinicPerson.nullable(),
  booking: clinicBookingEntry.nullable(),
});

export type StaffClinicSlotEntry = z.infer<typeof staffClinicSlotEntry>;

export const staffClinicViewResponse = z.object({
  clinic: clinicEntry,
  blocks: z.array(clinicRoomBlockEntry),
  slots: z.array(staffClinicSlotEntry),
  // Bookings that were cancelled but whose Outlook cancellation failed, so
  // staff can retry it.
  cancelledWithCalendarErrors: z.array(
    clinicBookingEntry.extend({ slotStartAt: z.string(), room: z.string() }),
  ),
});

export type StaffClinicViewResponse = z.infer<typeof staffClinicViewResponse>;

export const studentClinicSlotEntry = z.object({
  id: z.string().min(1),
  room: z.string(),
  startAt: z.string(),
  endAt: z.string(),
  ca: clinicPerson,
  available: z.boolean(),
});

export type StudentClinicSlotEntry = z.infer<typeof studentClinicSlotEntry>;

export const studentClinicViewResponse = z.object({
  clinic: clinicEntry,
  signupOpen: z.boolean(),
  cancelCutoffHours: z.number(),
  team: z
    .object({ repoName: z.string(), members: z.array(clinicPerson) })
    .nullable(),
  myBooking: z
    .object({
      id: z.string().min(1),
      room: z.string(),
      startAt: z.string(),
      endAt: z.string(),
      ca: clinicPerson,
      calendarStatus: clinicCalendarStatus,
      canCancel: z.boolean(),
    })
    .nullable(),
  slots: z.array(studentClinicSlotEntry),
});

export type StudentClinicViewResponse = z.infer<
  typeof studentClinicViewResponse
>;

export const outlookStatusResponse = z.object({
  configured: z.boolean(),
  connected: z.boolean(),
  lastError: z.string().nullable(),
});

export type OutlookStatusResponse = z.infer<typeof outlookStatusResponse>;

export const calendarSyncResponse = z.object({
  calendarStatus: clinicCalendarStatus,
  calendarError: z.string().nullable(),
});

export type CalendarSyncResponse = z.infer<typeof calendarSyncResponse>;
