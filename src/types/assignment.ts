import { z, ZodLiteral } from "zod";
import { courseDateString, HumanReadableEnum, netIdSchema } from "./index.js";
import {
  AssignmentVisibility,
  AssignmentQuota,
  JobStatus,
  Category,
  JobType,
  AutogradableCategory,
} from "../generated/prisma/enums.js";

export const AssignmentVisibilityLabels: HumanReadableEnum<
  typeof AssignmentVisibility
> = {
  DEFAULT: "Default (Show at Open)",
  FORCE_CLOSE: "Closed",
  FORCE_OPEN: "Open",
  INVISIBLE_FORCE_CLOSE: "Invisble (Closed)",
};

export const JobStatusLabels: HumanReadableEnum<typeof JobStatus> = {
  PENDING: "Queued",
  RUNNING: "Running",
  COMPLETED: "Completed",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
  INFRA_ERROR: "Server Error",
  TIMEOUT: "Grading Timeout",
};

export const JobStatusColors: HumanReadableEnum<typeof JobStatus> = {
  PENDING: "muted",
  RUNNING: "info",
  COMPLETED: "success",
  FAILED: "danger",
  CANCELLED: "danger",
  INFRA_ERROR: "warning",
  TIMEOUT: "danger",
};

export const AssignmentQuotaLabels: HumanReadableEnum<typeof AssignmentQuota> =
  {
    DAILY: "per day",
    TOTAL: "total",
  };

export const CategoryLabels: HumanReadableEnum<typeof Category> = {
  LAB: "Lab",
  MP: "MP",
  ATTENDANCE: "Attendance",
  OTHER: "Other",
  FINAL: "Final Exam",
  BONUS: "Extra Credit",
};

export const JobTypeLabels: HumanReadableEnum<typeof JobType> = {
  FINAL_GRADING: "Final Grading",
  REGRADE: "Regrade",
  STUDENT_INITIATED: "Student Initiated",
  STAFF_INITIATED: "Staff Initiated",
  STAFF_INITIATED_GRADING: "Final Grading (Staff Initiated)",
};

export const coreAssignmentBodySchema = z.object({
  name: z.string().min(1, "You must specify an assignment name."),
  category: z.nativeEnum(AutogradableCategory),
  visibility: z.nativeEnum(AssignmentVisibility),
  quotaPeriod: z.nativeEnum(AssignmentQuota),
  quotaAmount: z.coerce.number().min(1),
  openAt: courseDateString,
  dueAt: courseDateString,
  jenkinsPipelineName: z
    .string()
    .transform((val) => (val.trim() === "" ? undefined : val.trim()))
    .optional(),
  studentExtendable: z.boolean(),
});

export const createAssignmentBodySchema = coreAssignmentBodySchema
  .extend({ id: z.string().min(1, "You must specify an assignment ID.") })
  .refine((data) => new Date(data.dueAt) > new Date(data.openAt), {
    message: "Assignment due date must be after open date.",
    path: ["dueAt"],
  })
  .refine((data) => new Date(data.dueAt) > new Date(), {
    message: "Assignment due date must be in the future.",
    path: ["dueAt"],
  });

export const updateAssignmentBodySchema = coreAssignmentBodySchema.refine(
  (data) => new Date(data.dueAt) > new Date(data.openAt),
  {
    message: "Assignment due date must be after open date.",
    path: ["dueAt"],
  },
);

export type UpdateAssignmentBody = z.infer<typeof updateAssignmentBodySchema>;

export const coreManualAssignmentBodySchema = z.object({
  name: z.string().min(1, "You must specify an assignment name."),
  category: z.nativeEnum(Category),
  visibility: z.nativeEnum(AssignmentVisibility),
});

export const createManualAssignmentBodySchema =
  coreManualAssignmentBodySchema.extend({
    id: z.string().min(1, "You must specify an assignment ID."),
  });
export const updateManualAssignmentBodySchema =
  createManualAssignmentBodySchema;
export type ManualAssignmentFormData = z.infer<
  typeof createManualAssignmentBodySchema
>;

export const assignmentsResponseEntry = z.object({
  name: z.string().min(1),
  id: z.string().min(1),
  category: z.nativeEnum(Category),
  visibility: z.nativeEnum(AssignmentVisibility),
  quotaPeriod: z.nativeEnum(AssignmentQuota),
  quotaAmount: z.number().min(1),
  openAt: courseDateString,
  dueAt: courseDateString,
  studentExtendable: z.boolean(),
});

export type AssignmentResponseEntry = z.infer<typeof assignmentsResponseEntry>;

export const courseResponseBody = z.object({
  name: z.string().min(1),
  assignments: z.array(assignmentsResponseEntry),
});

export const courseMetadataResponse = z.object({
  name: z.string().min(1),
});

export type CourseMetadataResponse = z.infer<typeof courseMetadataResponse>;

export type CourseInformationResponse = z.infer<typeof courseResponseBody>;

export type CreateAssignmentBody = z.infer<typeof createAssignmentBodySchema>;

export const getGradingEligibilityOutput = z.union([
  // Not eligible
  z.object({
    eligible: z.literal(false),
  }),
  // Eligible by staff status
  z.object({
    eligible: z.literal(true),
    source: z.object({ type: z.literal("STAFF") }),
    numRunsRemaining: z.literal("infinity"),
    runsRemainingPeriod: z.nativeEnum(AssignmentQuota),
  }),
  // Eligible by base assignment
  z.object({
    eligible: z.literal(true),
    source: z.object({ type: z.literal("ASSIGNMENT") }),
    numRunsRemaining: z.number().min(1), // Assuming min(1) means at least 1 run remaining
    runsRemainingPeriod: z.nativeEnum(AssignmentQuota),
  }),
  // Eligible by extension
  z.object({
    eligible: z.literal(true),
    source: z.object({ type: z.literal("EXTENSION"), extensionid: z.string() }),
    numRunsRemaining: z.number().min(1),
    runsRemainingPeriod: z.nativeEnum(AssignmentQuota),
  }),
]);

export type GetGradingEligibilityOutput = z.infer<
  typeof getGradingEligibilityOutput
>;

export const assignmentResponseBody = z.object({
  isStaff: z.boolean(),
  courseName: z.string().min(1),
  courseTimezone: z.string().min(1),
  assignmentName: z.string().min(1),
  feedbackBaseUrl: z.string().min(1),
  dueAt: courseDateString,
  openAt: courseDateString,
  studentRuns: z.array(
    z.object({
      id: z.string().min(1),
      status: z.nativeEnum(JobStatus),
      scheduledAt: courseDateString,
      dueAt: courseDateString,
    }),
  ),
  gradingEligibility: getGradingEligibilityOutput,
  latestCommit: z.union([
    z.object({
      sha: z.string().min(1),
      message: z.string().min(1),
      date: z.string().optional().nullable(),
      url: z.string().url(),
    }),
    z.null(),
  ]),
});

export type AssignmentInformationResponse = z.infer<
  typeof assignmentResponseBody
>;

export const createExtensionBody = z.object({
  quotaAmount: z.coerce.number().min(1),
  quotaPeriod: z.nativeEnum(AssignmentQuota),
  openAt: courseDateString,
  closeAt: courseDateString,
  netIds: z.array(netIdSchema).min(1),
  createFinalGradingRun: z.boolean(),
});

export type AssignmentExtensionBody = z.infer<typeof createExtensionBody>;

export const getAssignmentRuns = z.array(
  z.object({
    type: z.nativeEnum(JobType),
    id: z.string().min(1),
    buildUrl: z.string().url().nullable(),
    dueAt: z.string().datetime().optional(),
    scheduledAt: z.string().datetime().optional(),
    netId: z.array(netIdSchema).min(1),
    status: z.nativeEnum(JobStatus),
  }),
);

export type AssignmentRuns = z.infer<typeof getAssignmentRuns>;

export const assignmentGradesResponse = z.object({
  assignmentName: z.string(),
  grades: z.array(
    z.object({
      netId: netIdSchema,
      score: z.number().min(0),
      comments: z.string().nullable(),
      createdAt: z.optional(z.string().datetime().nullable()),
      updatedAt: z.optional(z.string().datetime().nullable()),
    }),
  ),
});

export type AssignmentGrades = z.infer<typeof assignmentGradesResponse>;
