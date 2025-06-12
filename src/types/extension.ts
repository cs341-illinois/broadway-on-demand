import { z } from "zod";
import { courseDateString, netIdSchema } from "./index.js";
import {
  AssignmentQuota,
  ExtensionInitiator,
} from "../generated/prisma/enums.js";
import { assignmentsResponseEntry } from "./assignment.js";

export const selfExtensionsResponseSchema = z.object({
  courseName: z.string().min(1),
  courseCutoff: courseDateString,
  userAppliedExtensions: z.array(
    z.object({
      assignmentId: z.string().min(1),
      name: z.string().min(1),
      openAt: courseDateString,
      closeAt: courseDateString,
      quotaAmount: z.number().min(1),
      quotaPeriod: z.nativeEnum(AssignmentQuota),
    }),
  ),
  numExtensionsRemaining: z.number().min(0),
  numExtensionHours: z.number().min(0),
  visibleAssignments: z.array(assignmentsResponseEntry),
});

export type SelfExtensionsGetResponse = z.infer<
  typeof selfExtensionsResponseSchema
>;

export const assignmentExtensionResponseSchema = z.array(
  z.object({
    id: z.string().min(1),
    netId: netIdSchema,
    openAt: courseDateString,
    closeAt: courseDateString,
    quotaAmount: z.number().min(1),
    quotaPeriod: z.nativeEnum(AssignmentQuota),
    extensionType: z.nativeEnum(ExtensionInitiator),
    hasFinalGradingRun: z.boolean(),
    createdBy: netIdSchema,
  }),
);

export type AssignmentExtensionsGetResponse = z.infer<
  typeof assignmentExtensionResponseSchema
>;
