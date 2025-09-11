import { AssignmentQuota, Prisma } from "../generated/prisma/client.js";
import moment, { relativeTimeRounding } from "moment-timezone";
import { DatabaseFetchError } from "../errors/index.js";

type GetActiveExtensionsInput = {
  tx: Prisma.TransactionClient;
  courseId: string;
  assignmentId: string;
  netId: string;
};

export async function getActiveExtensions({
  tx,
  courseId,
  assignmentId,
  netId,
}: GetActiveExtensionsInput) {
  const currentDate = moment.utc().toDate();
  let result = await tx.extensions
    .findMany({
      where: {
        courseId,
        assignmentId,
        netId,
        openAt: {
          lte: currentDate,
        },
        closeAt: {
          gt: currentDate,
        },
      },
      include: {
        ExtensionUsageHistory: true,
      },
      orderBy: {
        closeAt: "asc",
      },
    })
    .catch((e) => {
      throw new DatabaseFetchError({
        message: "Could not get current extensions.",
      });
    });
  const { courseTimezone } = await tx.course.findFirstOrThrow({
    where: { id: courseId },
    select: { courseTimezone: true },
  });
  result = result.filter((x) => {
    switch (x.quotaPeriod) {
      case AssignmentQuota.DAILY:
        const todayRuns = x.ExtensionUsageHistory.filter((x) => {
          const startDayUtc = moment
            .tz(courseTimezone)
            .startOf("day")
            .utc()
            .toDate();
          const endDayUtc = moment
            .tz(courseTimezone)
            .endOf("day")
            .utc()
            .toDate();
          return x.createdAt < endDayUtc && x.createdAt > startDayUtc;
        });
        return todayRuns.length < x.quotaAmount;
      case AssignmentQuota.TOTAL:
        return x.ExtensionUsageHistory.length < x.quotaAmount;
    }
  });
  return result;
}
