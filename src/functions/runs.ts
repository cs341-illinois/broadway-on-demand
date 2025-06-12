import {
  AssignmentQuota,
  JobStatus,
  JobType,
  Prisma,
} from "../generated/prisma/client.js";
import moment from "moment-timezone";
import { DatabaseFetchError } from "../errors/index.js";
import { type FastifyBaseLogger } from "fastify";
import { getAssignmentDueDate } from "./assignment.js";

type GetAssignmentQuotaAppliedRunsInput = {
  tx: Prisma.TransactionClient;
  courseId: string;
  assignmentId: string;
  netId: string;
  quotaAmount: number;
  quotaPeriod: AssignmentQuota;
  courseTimezone: string;
};
export async function getAssignmentQuotaAppliedRuns({
  tx,
  courseId,
  assignmentId,
  netId,
  quotaPeriod,
  courseTimezone,
}: GetAssignmentQuotaAppliedRunsInput) {
  const startDayUtc = moment.tz(courseTimezone).startOf("day").utc();
  const endDayUtc = moment.tz(courseTimezone).endOf("day").utc();
  let quotaQueryModifier = {};
  switch (quotaPeriod) {
    case "TOTAL":
      break;
    case "DAILY":
      quotaQueryModifier = {
        dueAt: {
          gt: startDayUtc.toDate(),
          lt: endDayUtc.toDate(),
        },
      };
  }
  const applicableRuns = await tx.job.findMany({
    where: {
      courseId,
      netId: { has: netId },
      status: {
        not: JobStatus.INFRA_ERROR,
      },
      assignmentId,
      type: JobType.STUDENT_INITIATED,
      ...quotaQueryModifier,
    },
    select: {
      id: true,
    },
  });
  return applicableRuns;
}
