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
  result = result.filter((extension) => {
    switch (extension.quotaPeriod) {
      case AssignmentQuota.DAILY:
        const todayRuns = extension.ExtensionUsageHistory.filter((usage) => {
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
          return usage.createdAt < endDayUtc && usage.createdAt > startDayUtc;
        });
        return todayRuns.length < extension.quotaAmount;
      case AssignmentQuota.TOTAL:
        return extension.ExtensionUsageHistory.length < extension.quotaAmount;
    }
  });
  return result;
}
