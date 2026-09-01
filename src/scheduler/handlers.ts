import { type PrismaClient, Job, Role } from "../generated/prisma/client.js";
import { type FastifyBaseLogger } from "fastify";
import { type RedisClientType } from "redis";
import { InternalServerError } from "../errors/index.js";
import { startGradingRun } from "../functions/gradeAssignment.js";
import {
  getPartnerRotationPeriodIndex,
  runPartnerRotationForCourse,
} from "../functions/partners.js";

type StartScheduledJobInput = {
  job: Job;
  redisClient: RedisClientType;
  prismaClient: PrismaClient;
  logger: FastifyBaseLogger;
};
export const startScheduledJob = async ({
  job,
  redisClient,
  prismaClient,
  logger,
}: StartScheduledJobInput) => {
  const jobId = job.id;
  const lockTs = new Date().getTime();
  const response = await redisClient.set(`scheduler_lock:${jobId}`, lockTs, {
    NX: true,
    PX: 30000,
  });
  if (!response) {
    logger.error(
      `Someone else already holds the lock for job ID ${jobId}, skipping!`,
    );
  }
  try {
    const { jenkinsBaseUrl, courseTimezone, jenkinsToken } =
      await prismaClient.course.findFirstOrThrow({
        where: {
          id: job.courseId,
        },
        select: {
          jenkinsBaseUrl: true,
          courseTimezone: true,
          jenkinsToken: true,
        },
      });
    const { jenkinsPipelineName } = await prismaClient.assignment
      .findFirstOrThrow({
        where: {
          id: job.assignmentId,
          courseId: job.courseId,
        },
        select: {
          jenkinsPipelineName: true,
        },
      })
      .catch((e) => {
        logger.error(e);
        throw new InternalServerError({
          message: "Could not find assignment data.",
        });
      });
    let netIds = job.netId;
    if (netIds.length === 1 && netIds[0] === "_ALL_") {
      const courseStudents = await prismaClient.users.findMany({
        where: {
          courseId: job.courseId,
          role: Role.STUDENT,
          enabled: true,
        },
        select: {
          netId: true,
        },
      });
      netIds = courseStudents.map((x) => x.netId);
    }
    const queueUrl = await startGradingRun({
      courseId: job.courseId,
      jenkinsPipelineName: jenkinsPipelineName || job.assignmentId,
      netIds,
      isoTimestamp: job.dueAt.toISOString(),
      type: job.type,
      gradingRunId: job.id,
      jenkinsBaseUrl,
      courseTimezone,
      jenkinsToken,
      logger,
    });
    if (queueUrl) {
      await prismaClient.job.update({
        where: { id: job.id },
        data: { queueUrl }
      })
    } else {
      logger.error(`Could not find queue URL for job ${job.id}!`)
    }
    logger.info(`Triggered job ID ${job.id} with Jenkins.`);
  } finally {
    logger.debug("Releasing job lock.");
    const lockValue = await redisClient.get(`scheduler_lock:${jobId}`);
    if (!lockValue) {
      logger.error(
        "Lock was already released before we finished, this is bad!",
      );
      return;
    }
    const retrievedLockTs = parseInt(lockValue, 10);
    if (lockTs !== retrievedLockTs) {
      logger.error(
        "Lock was already released and reset before we finished, this is bad!",
      );
      return;
    }
    await redisClient.del(`scheduler_lock:${jobId}`);
    logger.debug("Released job lock.");
  }
};

type RunPartnerRotationJobInput = {
  job: Job;
  prismaClient: PrismaClient;
  logger: FastifyBaseLogger;
};

/**
 * Handler for JobType.PARTNER_ROTATION jobs. Unlike the grading job handlers
 * above, this doesn't talk to Jenkins at all - it just generates this
 * period's Lab partner groups for every lab section that doesn't already
 * have them.
 */
export const runPartnerRotationJob = async ({
  job,
  prismaClient,
  logger,
}: RunPartnerRotationJobInput) => {
  const { firstLabDate } = await prismaClient.course.findFirstOrThrow({
    where: { id: job.courseId },
    select: { firstLabDate: true },
  });
  const periodIndex = getPartnerRotationPeriodIndex({
    firstLabDate,
    date: job.dueAt,
  });
  const { sectionsGrouped, sectionsSkipped } = await prismaClient.$transaction(
    (tx) =>
      runPartnerRotationForCourse({ tx, courseId: job.courseId, periodIndex }),
  );
  logger.info(
    `Partner rotation for course ${job.courseId}, period ${periodIndex}: ` +
      `grouped sections [${sectionsGrouped.join(", ")}], already-grouped sections skipped [${sectionsSkipped.join(", ")}].`,
  );
};
