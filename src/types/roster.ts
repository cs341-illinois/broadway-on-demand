import { z } from "zod";
import { Role } from "../generated/prisma/client.js";
import { netIdSchema } from "./index.js";

export const rosterUserSchema = z.object({
  netId: netIdSchema,
  role: z.nativeEnum(Role),
  uin: z.string().optional().nullable(),
  name: z.string().optional().nullable(),
});

export const rosterStudentSchema = z.object({
  netId: netIdSchema,
  uin: z.string().min(1),
  name: z.string().min(1),
});

export const manageRosterRequestBodySchema = z.object({
  action: z.enum(["add", "disable"], {
    required_error: "Action is required.",
    invalid_type_error: "Action must be either 'add' or 'disable'.",
  }),
  users: z
    .array(rosterUserSchema)
    .min(1, "Users array cannot be empty and must contain at least one user."),
});

export const overwriteStudentRosterBodySchema = z
  .array(rosterStudentSchema)
  .min(1, "Users array cannot be empty and must contain at least one user.");

export type OverwriteStudentRosterBody = z.infer<
  typeof overwriteStudentRosterBodySchema
>;

export const rosterManagementDetailSchema = z.object({
  netId: netIdSchema,
  status: z.string(),
  message: z.string().optional(),
});

export const manageRosterSuccessResponseSchema = z.object({
  operationStatus: z.string(),
  results: z.array(rosterManagementDetailSchema),
});
