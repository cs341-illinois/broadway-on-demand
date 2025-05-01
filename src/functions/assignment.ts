import {
  AssignmentQuota,
  AssignmentVisibility,
  JobStatus,
  JobType,
  PrismaClient,
} from "@prisma/client";
import { PrismaJobRepository } from "../scheduler/prismaRepository.js";
import { DatabaseInsertError } from "../errors/index.js";
import { AutogradableCategory, Category } from "../types/assignment.js";

type CreateAssignmentInput = {
  client: PrismaClient;
  courseId: string;
  assignmentId: string;
  name: string;
  dueAt: Date;
  visibility: AssignmentVisibility;
  quotaAmount: number;
  quotaPeriod: AssignmentQuota;
  openAt: Date;
  category: Category | AutogradableCategory;
};
export async function createAssignment({
  client,
  courseId,
  assignmentId,
  name,
  dueAt,
  visibility,
  quotaAmount,
  quotaPeriod,
  openAt,
  category,
}: CreateAssignmentInput) {
  await client
    .$transaction(async (tx) => {
      const jobRepo = new PrismaJobRepository(tx);
      const assignment = await tx.assignment
        .create({
          data: {
            id: assignmentId,
            name,
            courseId,
            visibility,
            quotaAmount,
            quotaPeriod,
            openAt,
            category,
          },
        })
        .catch((e) => {
          throw new DatabaseInsertError({
            message: "Could not insert assignment.",
          });
        });
      const { id: jobId } = await jobRepo
        .createJob({
          name: "runScheduledGradingJob",
          dueAt,
          scheduledAt: new Date(dueAt.getTime() + 5 * 60000), // schedule 5 minutes after the due time to avoid race conditions
          courseId: courseId,
          assignmentId: assignmentId,
          type: JobType.FINAL_GRADING,
        })
        .catch((e) => {
          throw new DatabaseInsertError({
            message: "Could not schedule grading job.",
          });
        });
      await tx.assignment
        .update({
          where: {
            courseId_id: {
              courseId: courseId,
              id: assignment.id,
            },
          },
          data: {
            finalGradingRunId: jobId,
          },
        })
        .catch((e) => {
          throw new DatabaseInsertError({
            message: "Could not pair grading job.",
          });
        });
    })
    .catch((e) => {
      throw e;
    });
}
