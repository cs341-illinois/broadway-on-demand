import {
  AssignmentQuota,
  AssignmentVisibility,
  JobStatus,
  JobType,
} from "../generated/prisma/enums.js";
import { Prisma, PrismaClient } from "../generated/prisma/client.js";
import { PrismaJobRepository } from "../scheduler/prismaRepository.js";
import {
  DatabaseDeleteError,
  DatabaseFetchError,
  DatabaseInsertError,
  ValidationError,
} from "../errors/index.js";
import {
  getGradingEligibilityOutput,
  GetGradingEligibilityOutput,
} from "../types/assignment.js";
import { AutogradableCategory, Category } from "../generated/prisma/client.js";
import { getAssignmentQuotaAppliedRuns } from "./runs.js";
import { getActiveExtensions } from "./extensions.js";
import { type JobScheduler } from "../scheduler/scheduler.js";
import { FastifyBaseLogger } from "fastify";

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
  jenkinsPipelineName?: string;
  studentExtendable: boolean;
};

type DeleteAssignmentInput = {
  client: PrismaClient;
  courseId: string;
  assignmentId: string;
  logger: FastifyBaseLogger;
  scheduler: JobScheduler;
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
  jenkinsPipelineName,
  studentExtendable,
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
            jenkinsPipelineName,
            studentExtendable,
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
          netId: ["_ALL_"],
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

export async function modifyAssignment({
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
  jenkinsPipelineName,
}: CreateAssignmentInput) {
  await client.$transaction(async (tx) => {
    const jobRepo = new PrismaJobRepository(tx);
    const { finalGradingRunId } = await tx.assignment
      .update({
        where: {
          courseId_id: {
            courseId,
            id: assignmentId,
          },
        },
        data: {
          name,
          visibility,
          quotaAmount,
          quotaPeriod,
          openAt,
          category,
          jenkinsPipelineName,
        },
        select: {
          finalGradingRunId: true,
        },
      })
      .catch((e) => {
        throw new DatabaseInsertError({
          message: "Could not update assignment entry.",
        });
      });
    const payload = {
      name: "runScheduledGradingJob",
      dueAt,
      scheduledAt: new Date(dueAt.getTime() + 5 * 60000), // schedule 5 minutes after the due time to avoid race conditions
      status: JobStatus.PENDING,
      buildUrl: null,
      courseId: courseId,
      assignmentId: assignmentId,
      type: JobType.FINAL_GRADING,
      netId: "_ALL_",
    };
    if (!finalGradingRunId) {
      const { id: jobId } = await jobRepo
        .createJob({ ...payload, netId: [payload.netId] })
        .catch((e) => {
          throw new DatabaseInsertError({
            message: "Could not schedule grading job.",
          });
        });
      await tx.assignment
        .update({
          where: {
            courseId_id: { courseId, id: assignmentId },
          },
          data: {
            finalGradingRunId: jobId,
          },
        })
        .catch((e) => {
          throw new DatabaseInsertError({
            message: "Could not pair final grading job ID.",
          });
        });
    } else {
      const oldJob = await jobRepo.findJobById(finalGradingRunId);
      if (oldJob && oldJob.status === JobStatus.RUNNING) {
        throw new ValidationError({
          message:
            "Cannot change the due date as the final grading job is currently running. Please try again later.",
        });
      }
      await jobRepo.deleteJob(finalGradingRunId);
      const newJob = await jobRepo
        .createJob({ ...payload, netId: [payload.netId] })
        .catch((e) => {
          throw new DatabaseInsertError({
            message: "Could not update scheduler job repository.",
          });
        });
      await tx.assignment
        .update({
          where: {
            courseId_id: { courseId, id: assignmentId },
          },
          data: {
            finalGradingRunId: newJob.id,
          },
        })
        .catch((e) => {
          throw new DatabaseInsertError({
            message: "Could not pair new final grading job ID.",
          });
        });
    }
  });
}

export async function deleteAssignment({
  client,
  courseId,
  assignmentId,
  logger,
  scheduler,
}: DeleteAssignmentInput) {
  await client.$transaction(async (tx) => {
    const res = await tx.assignment
      .delete({
        where: {
          courseId_id: {
            courseId,
            id: assignmentId,
          },
        },
        select: {
          finalGradingRunId: true,
        },
      })
      .catch((e) => {
        logger.error(e);
        let message = "Could not delete assignment entry.";
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === "P2003"
        ) {
          message =
            "This assignment cannot be deleted due to existing data. You may close the assignment instead.";
        }
        throw new DatabaseDeleteError({
          message,
        });
      });
    if (!res.finalGradingRunId) {
      return;
    }
    const jobStore = new PrismaJobRepository(tx);
    await jobStore.deleteJob(res.finalGradingRunId);
    await tx.job
      .deleteMany({
        where: {
          courseId,
          assignmentId,
        },
      })
      .catch((e) => {
        throw new DatabaseDeleteError({
          message: "Could not delete scheduled jobs.",
        });
      });
  });
  await scheduler.refreshJobs();
}

export async function getAssignmentDueDate({
  tx,
  courseId,
  assignmentId,
}: {
  tx: Prisma.TransactionClient;
  courseId: string;
  assignmentId: string;
}): Promise<Date | null> {
  const { finalGradingRunId } = await tx.assignment
    .findFirstOrThrow({
      where: {
        courseId,
        id: assignmentId,
      },
      select: { finalGradingRunId: true },
    })
    .catch((e) => {
      throw new DatabaseFetchError({ message: "Could not find assignment" });
    });
  if (!finalGradingRunId) {
    return null;
  }
  const result = await tx.job
    .findFirstOrThrow({
      where: {
        type: JobType.FINAL_GRADING,
        assignmentId: assignmentId,
        courseId: courseId,
        id: finalGradingRunId,
      },
      select: {
        dueAt: true,
      },
    })
    .catch((_e) => null);
  if (result) {
    return result.dueAt;
  }
  return null;
}

export function getFolderNameForAssignment(assignmentId: string): string {
  return assignmentId.replace(/_pt\d+$/, "");
}

export type GetGradingEligibilityInput = {
  tx: PrismaClient | Prisma.TransactionClient;
  courseId: string;
  assignmentId: string;
  netId: string;
  courseTimezone?: string;
};

export async function getGradingEligibility({
  tx,
  courseId,
  assignmentId,
  netId,
  courseTimezone,
}: GetGradingEligibilityInput): Promise<GetGradingEligibilityOutput> {
  let gradingEligibility: GetGradingEligibilityOutput;

  // Determine eligibility based on original assignment
  courseTimezone =
    courseTimezone ||
    (
      await tx.course.findFirstOrThrow({
        where: { id: courseId },
        select: { courseTimezone: true },
      })
    ).courseTimezone;
  const { quotaPeriod, quotaAmount, visibility, openAt } =
    await tx.assignment.findFirstOrThrow({
      where: {
        courseId,
        id: assignmentId,
      },
      select: {
        quotaAmount: true,
        quotaPeriod: true,
        visibility: true,
        openAt: true,
      },
    });

  if (
    visibility == AssignmentVisibility.FORCE_CLOSE ||
    visibility == AssignmentVisibility.INVISIBLE_FORCE_CLOSE
  ) {
    gradingEligibility = { eligible: false };
  } else {
    const assignmentDueDatePromise = getAssignmentDueDate({
      tx,
      courseId,
      assignmentId,
    });
    const extensionsPromise = getActiveExtensions({
      tx,
      courseId,
      assignmentId,
      netId,
    });
    const assignmentPeriodRuns = await getAssignmentQuotaAppliedRuns({
      tx,
      courseId,
      assignmentId,
      netId,
      quotaPeriod,
      quotaAmount,
      courseTimezone,
    });
    const extensions = await extensionsPromise;
    const assignmentDueDate = await assignmentDueDatePromise;

    if (!assignmentDueDate) {
      throw new DatabaseFetchError({
        message: "Could not find due date for assignment.",
      });
    }

    const assignmentIsOpen =
      (visibility == AssignmentVisibility.FORCE_OPEN ||
        (assignmentDueDate > new Date() && openAt < new Date())) &&
      quotaAmount - assignmentPeriodRuns.length > 0;

    if (extensions.length === 0) {
      const numRunsRemaining = Math.max(
        0,
        quotaAmount - assignmentPeriodRuns.length,
      );
      if (assignmentIsOpen && numRunsRemaining > 0) {
        gradingEligibility = {
          eligible: true,
          source: { type: "ASSIGNMENT" },
          numRunsRemaining,
          runsRemainingPeriod: quotaPeriod as any,
        };
      } else {
        gradingEligibility = { eligible: false };
      }
    } else {
      const numRunsRemaining = Math.max(
        0,
        extensions[0].quotaAmount - extensions[0].ExtensionUsageHistory.length,
      );
      if (numRunsRemaining === 0) {
        gradingEligibility = { eligible: false };
      } else {
        gradingEligibility = {
          eligible: true,
          source: { type: "EXTENSION", extensionid: extensions[0].id },
          numRunsRemaining,
          runsRemainingPeriod: extensions[0].quotaPeriod as any,
        };
      }
    }
  }

  return await getGradingEligibilityOutput.parseAsync(gradingEligibility);
}

export async function getAutogradableAssignments({
  courseId,
  prismaClient,
  showInvisible,
  showUnextendable,
}: {
  courseId: string;
  prismaClient: PrismaClient | Prisma.TransactionClient;
  showInvisible: boolean;
  showUnextendable: boolean;
}) {
  const assignments = await prismaClient.assignment.findMany({
    where: {
      courseId,
      ...(showInvisible
        ? {}
        : {
            visibility: {
              not: AssignmentVisibility.INVISIBLE_FORCE_CLOSE,
            },
          }),
      ...(showUnextendable ? {} : { studentExtendable: true }),
      category: {
        in: [AutogradableCategory.LAB, AutogradableCategory.MP],
      },
    },
    orderBy: {
      openAt: "desc",
    },
  });

  const finalGradingRunIds = assignments
    .map((a) => a.finalGradingRunId)
    .filter((id): id is string => !!id);

  const finalJobs = await prismaClient.job.findMany({
    where: {
      id: { in: finalGradingRunIds },
    },
    select: {
      id: true,
      dueAt: true,
    },
  });

  const jobsById = Object.fromEntries(finalJobs.map((job) => [job.id, job]));

  return assignments
    .filter((assignment) => assignment.finalGradingRunId)
    .map((assignment) => ({
      ...assignment,
      finalGradingRunId: undefined,
      createdAt: undefined,
      updatedAt: undefined,
      courseId: undefined,
      category: assignment.category as AutogradableCategory,
      openAt: assignment.openAt.toISOString(),
      dueAt: jobsById[assignment.finalGradingRunId!]?.dueAt.toISOString(),
    }));
}

export const getVisibleAssignments = async ({
  courseId,
  prismaClient,
  showInvisible,
}: {
  courseId: string;
  prismaClient: PrismaClient | Prisma.TransactionClient;
  showInvisible: boolean;
}) => {
  const assignmentsWithDueDates = await getAutogradableAssignments({
    courseId,
    prismaClient,
    showInvisible,
    showUnextendable: true,
  });
  const filteredAssignments = assignmentsWithDueDates.filter((x) => {
    if (showInvisible || x.visibility == AssignmentVisibility.FORCE_OPEN) {
      return true;
    }
    if (x.visibility == AssignmentVisibility.DEFAULT) {
      return new Date(x.openAt) < new Date(); // don't show unopened assignments.
    }
    if (x.visibility == AssignmentVisibility.INVISIBLE_FORCE_CLOSE) {
      return false;
    }
    return true;
  });
  return filteredAssignments;
};
