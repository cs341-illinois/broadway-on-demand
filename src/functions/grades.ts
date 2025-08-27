import {
  AssignmentVisibility,
  Category,
  Prisma,
} from "../generated/prisma/client.js";
import { BaseError, DatabaseFetchError } from "../errors/index.js";
import { FastifyBaseLogger } from "fastify";

export type GradeEntry = {
  netId: string;
  score: number;
  comments?: string;
};

export async function getUserGrades({
  tx,
  courseId,
  netId,
  logger,
}: {
  tx: Prisma.TransactionClient;
  courseId: string;
  netId: string;
  logger: FastifyBaseLogger;
}) {
  const assignments = await tx.assignment
    .findMany({
      select: {
        id: true,
        name: true,
        category: true,
      },
      where: {
        courseId,
        visibility: { not: AssignmentVisibility.INVISIBLE_FORCE_CLOSE },
        PublishedGrades: {
          some: {},
        },
      },
    })
    .catch((e) => {
      logger.error(e);
      throw new DatabaseFetchError({
        message: "Could not get assignments.",
      });
    });

  const publishedGrades = await tx.publishedGrades
    .findMany({
      select: {
        assignmentId: true,
        assignment: {
          select: {
            name: true,
            category: true,
          },
        },
        comments: true,
        score: true,
        createdAt: true,
        updatedAt: true,
      },
      where: {
        courseId,
        netId,
      },
      orderBy: {
        createdAt: "asc",
      },
    })
    .catch((e) => {
      logger.error(e);
      if (e instanceof BaseError) {
        throw e;
      }
      throw new DatabaseFetchError({
        message: "Could not get user grades.",
      });
    });

  const gradesMap = new Map(
    publishedGrades.map((grade) => [grade.assignmentId, grade]),
  );
  const mappedGrades = assignments.map((assignment) => {
    const gradeEntry = gradesMap.get(assignment.id);

    if (gradeEntry) {
      return {
        id: gradeEntry.assignmentId,
        name: gradeEntry.assignment.name,
        comments: gradeEntry.comments,
        score: gradeEntry.score,
        category: gradeEntry.assignment.category,
        createdAt: gradeEntry.createdAt.toISOString(),
        updatedAt: gradeEntry.updatedAt.toISOString(),
      };
    } else {
      return {
        id: assignment.id,
        name: assignment.name,
        comments:
          assignment.category === Category.ATTENDANCE
            ? "You did not attend this lab session (yet)."
            : "No grade is available for this assignment.",
        score: 0,
        category: assignment.category,
      };
    }
  });
  return mappedGrades;
}
