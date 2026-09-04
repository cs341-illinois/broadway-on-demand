import { AssignmentVisibility, Prisma } from "../generated/prisma/client.js";
import { BaseError, DatabaseFetchError } from "../errors/index.js";
import { FastifyBaseLogger } from "fastify";
import { calculateFinalGrade, GradebookResponse } from "../types/gradebook.js";

// Deliberately independent of getVisibleAssignments/getUserGrades
// (src/functions/assignment.ts, src/functions/grades.ts): those hard-filter
// to Jenkins-graded LAB/MP assignments with a finalGradingRunId, which would
// silently exclude manual, PrairieLearn, and every other non-Jenkins
// assignment the gradebook needs to show.
export async function getGradebookForStudent({
  tx,
  courseId,
  netId,
  logger,
}: {
  tx: Prisma.TransactionClient;
  courseId: string;
  netId: string;
  logger: FastifyBaseLogger;
}): Promise<GradebookResponse> {
  const [assignments, categoryConfigs] = await Promise.all([
    tx.assignment
      .findMany({
        where: {
          courseId,
          visibility: { not: AssignmentVisibility.INVISIBLE_FORCE_CLOSE },
        },
        select: {
          id: true,
          name: true,
          category: true,
          weight: true,
          PublishedGrades: {
            where: { netId },
            select: { score: true, comments: true },
          },
        },
      })
      .catch((e) => {
        logger.error(e);
        throw new DatabaseFetchError({
          message: "Could not get gradebook assignments.",
        });
      }),
    tx.gradingCategoryConfig
      .findMany({
        where: { courseId },
        select: { category: true, dropLowest: true },
      })
      .catch((e) => {
        logger.error(e);
        if (e instanceof BaseError) {
          throw e;
        }
        throw new DatabaseFetchError({
          message: "Could not get grading category configuration.",
        });
      }),
  ]);

  const gradebookAssignments = assignments.map((a) => {
    const grade = a.PublishedGrades[0];
    return {
      id: a.id,
      name: a.name,
      category: a.category,
      weight: a.weight,
      score: grade ? grade.score : null,
      comments: grade?.comments ?? null,
    };
  });

  const { finalGrade } = calculateFinalGrade(gradebookAssignments, categoryConfigs);

  return {
    assignments: gradebookAssignments,
    categoryConfigs,
    currentGrade: finalGrade,
  };
}
