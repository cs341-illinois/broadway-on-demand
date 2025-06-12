import { z } from "zod";
import { gradeEntry } from "./grades.js";
import { courseDateString, netIdSchema } from "./index.js";
import { ExtensionInitiator, Role } from "../generated/prisma/client.js";

export const studentInfoResponse = z.object({
  meta: z.object({
    name: z.string().min(1).optional().nullable(),
    uin: z.string().min(1).optional().nullable(),
    role: z.nativeEnum(Role),
    courseName: z.string().min(1),
    netId: netIdSchema,
    enabled: z.boolean(),
  }),
  grades: z.array(gradeEntry),
  extensions: z.array(
    z.object({
      assignmentId: z.string().min(1),
      name: z.string().min(1),
      openAt: courseDateString,
      closeAt: courseDateString,
      createdBy: z.string().min(1),
      initiator: z.nativeEnum(ExtensionInitiator),
    }),
  ),
});

export type StudentInfoResponse = z.infer<typeof studentInfoResponse>;
