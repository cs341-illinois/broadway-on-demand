import { z } from "zod";
import { courseDateString, netIdSchema } from "./index.js";

export const courseLabsInfoResponse = z.object({
  firstLabDate: courseDateString,
  courseTimezone: z.string().min(1),
  courseCutoff: courseDateString,
});

export type CourseLabsInfo = z.infer<typeof courseLabsInfoResponse>;

export const staffWeekAttendanceResponse = z.array(
  z.object({
    netId: netIdSchema,
    name: z.string().min(1),
    submitted: z.boolean(),
  }),
);

export const checkInAcceptedResponse = z.object({
  modified: z.boolean(),
  name: z.string().min(1),
  netId: netIdSchema,
});

export type WeekAtttendanceStaffInfo = z.infer<
  typeof staffWeekAttendanceResponse
>;

export type CheckInAcceptedResponse = z.infer<typeof checkInAcceptedResponse>;
