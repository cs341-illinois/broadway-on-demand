import { z } from "zod";
import { netIdSchema } from "./index.js";

export const gradeEntry = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  comments: z.string().nullable(),
  score: z.number().min(0).max(100),
  createdAt: z.optional(z.string().datetime()),
  updatedAt: z.optional(z.string().datetime()),
  category: z.string().min(1),
});

export const getUserGradesResponseSchema = z.array(gradeEntry);

const gradesArray = z.array(
  z.object({
    netId: netIdSchema,
    score: z.number(),
    createdAt: z.optional(z.string().datetime()),
    updatedAt: z.optional(z.string().datetime()),
  }),
);

export const getAssignmentGradesResponse = z.object({
  publishedGrades: gradesArray,
});

export type GetAssignmentGradesResponse = z.infer<
  typeof getAssignmentGradesResponse
>;

export type UserGradesResponse = z.infer<typeof getUserGradesResponseSchema>;

export const gradeUploadEntry = z.object({
  netId: netIdSchema,
  score: z.number().min(0),
  comments: z.optional(z.string().nullable()),
});

export const assignmentGradeUploadbody = z.array(gradeUploadEntry);

export type GradeEntry = z.infer<typeof gradeUploadEntry>;
