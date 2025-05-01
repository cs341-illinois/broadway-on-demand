import { z } from "zod";
import { HumanReadableEnum } from "./index.js";
import {
  Prisma,
  AssignmentVisibility as PrismaAssignmentVisibility,
  AssignmentQuota as PrismaAssignmentQuota,
  JobStatus,
} from "@prisma/client";

export enum AssignmentVisibility {
  DEFAULT = "DEFAULT",
  FORCE_OPEN = "FORCE_OPEN",
  FORCE_CLOSE = "FORCE_CLOSE",
  INVISIBLE_FORCE_CLOSE = "INVISIBLE_FORCE_CLOSE",
}

export const AssignmentVisibilityLabels: HumanReadableEnum<
  typeof AssignmentVisibility
> = {
  DEFAULT: "Default",
  FORCE_CLOSE: "Closed",
  FORCE_OPEN: "Open",
  INVISIBLE_FORCE_CLOSE: "Invisble (Closed)",
};

export enum AssignmentQuota {
  DAILY = "DAILY",
  TOTAL = "TOTAL",
}

export const AssignmentQuotaLabels: HumanReadableEnum<typeof AssignmentQuota> =
  {
    DAILY: "per day",
    TOTAL: "total",
  };

export enum Category {
  LAB = "LAB",
  MP = "MP",
  ATTENDANCE = "ATTENDANCE",
  OTHER = "OTHER",
}

export const CategoryLabels: HumanReadableEnum<typeof Category> = {
  LAB: "Lab",
  MP: "MP",
  ATTENDANCE: "Attendance",
  OTHER: "Other",
};

export enum AutogradableCategory {
  LAB = Category.LAB,
  MP = Category.MP,
}

export const createAssignmentBodySchema = z
  .object({
    name: z.string().min(1),
    id: z.string().min(1),
    category: z.nativeEnum(AutogradableCategory),
    visibility: z.nativeEnum(AssignmentVisibility),
    quotaPeriod: z.nativeEnum(AssignmentQuota),
    quotaAmount: z.number().min(1),
    openAt: z.coerce.date().transform((date) => {
      const utc = new Date(date.toISOString());
      utc.setUTCSeconds(0, 0);
      return utc;
    }),
    dueAt: z.coerce.date().transform((date) => {
      const utc = new Date(date.toISOString());
      utc.setUTCSeconds(0, 0);
      return utc;
    }),
  })
  .refine((data) => data.dueAt > data.openAt, {
    message: "Assignment due date must be after open date.",
    path: ["dueAt"],
  });

export const assignmentsResponseEntry = z.object({
  name: z.string().min(1),
  id: z.string().min(1),
  category: z.nativeEnum(AutogradableCategory),
  visibility: z.nativeEnum(PrismaAssignmentVisibility),
  quotaPeriod: z.nativeEnum(PrismaAssignmentQuota),
  quotaAmount: z.number().min(1),
  openAt: z.date(),
  dueAt: z.date(),
});

export const courseResponseBody = z.object({
  name: z.string().min(1),
  assignments: z.array(assignmentsResponseEntry),
});

export type CourseInformationResponse = z.infer<typeof courseResponseBody>;

export type CreateAssignmentBody = z.infer<typeof createAssignmentBodySchema>;

export const assignmentResponseBody = z.object({
  isStaff: z.boolean(),
  courseName: z.string().min(1),
  assignmentName: z.string().min(1),
  studentRuns: z.array(
    z.object({
      id: z.string().min(1),
      status: z.nativeEnum(JobStatus),
      dueAt: z.date(),
    }),
  ),
});

export type AssignmentInformationResponse = z.infer<
  typeof assignmentResponseBody
>;
