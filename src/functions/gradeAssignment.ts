import { Job, JobType } from "../generated/prisma/client.js";
import uuid4 from "uuid4";
import { EnumMapper } from "../types/index.js";
import { z } from "zod";
import moment from "moment-timezone";
import { GradingError, ValidationError } from "../errors/index.js";
import { type FastifyBaseLogger } from "fastify";
import config from "../config.js";

export type StartGradingRunInputs = {
  courseId: string;
  jenkinsPipelineName: string;
  netIds: string[];
  isoTimestamp: string;
  type: JobType;
  gradingRunId?: string;
  jenkinsBaseUrl: string;
  courseTimezone: string;
  jenkinsToken: string;
  logger: FastifyBaseLogger;
  expectedCommitHash?: string;
};

const dateFormatRegex = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

export const agDateSchema = z
  .string()
  .regex(dateFormatRegex, "Invalid date format, should be YYYY-MM-DD HH:MM:SS");

export const jenkinsPayloadSchema = z.object({
  STUDENT_IDS: z.string().min(1),
  BROADWAY_HOST: z.string().url().min(1),
  TERM_ID: z.string().min(1),
  COURSE_ID: z.string().min(1),
  DUE_DATE: z.union([agDateSchema, z.literal("now")]),
  PUBLISH_TO_STUDENT: z.boolean(),
  PUBLISH_FINAL_GRADE: z.boolean(),
  GRADING_RUN_ID: z.string().min(1),
  IS_REGRADE: z.boolean(),
  INTEGRITY_ONLY: z.optional(z.boolean()),
  JOB_PRIORITY: z.number().min(1).max(5),
  EXPECTED_COMMIT_HASH: z.string().default("")
});

export type JenkinsPayload = z.infer<typeof jenkinsPayloadSchema>;

type GetJenkinsParamsInputs = {
  courseId: string;
  netIds: string[];
  agDateTime: string;
  type: JobType;
  gradingRunId: string;
  logger: FastifyBaseLogger;
  expectedCommitHash?: string;
};

const getJobPriority = (jobType: JobType) => {
  switch (jobType) {
    case "STUDENT_INITIATED":
      return 1
    case "FINAL_GRADING":
      return 3
    case "REGRADE":
      return 4
    case "STAFF_INITIATED":
      return 1
    case "STAFF_INITIATED_GRADING":
      return 2
  }
}
const getJenkinsParams = ({
  courseId,
  netIds,
  agDateTime,
  type,
  gradingRunId,
  logger,
  expectedCommitHash
}: GetJenkinsParamsInputs): JenkinsPayload => {
  const proposedPayload = {
    STUDENT_IDS: netIds.join(","),
    BROADWAY_HOST: config.JENKINS_FACING_URL || config.HOST + config.BASE_URL,
    TERM_ID: courseId.split("-")[1],
    COURSE_ID: courseId.split("-")[0],
    DUE_DATE: agDateTime,
    PUBLISH_TO_STUDENT: type !== JobType.STAFF_INITIATED,
    PUBLISH_FINAL_GRADE:
      type === JobType.FINAL_GRADING ||
      type === JobType.REGRADE ||
      type == JobType.STAFF_INITIATED_GRADING,
    IS_REGRADE: type === JobType.REGRADE,
    INTEGRITY_ONLY: false,
    GRADING_RUN_ID: gradingRunId,
    JOB_PRIORITY: getJobPriority(type),
    EXPECTED_COMMIT_HASH: expectedCommitHash
  };
  const { data, success, error } =
    jenkinsPayloadSchema.safeParse(proposedPayload);
  if (!success) {
    logger.error(error);
    throw new ValidationError({
      message: "Could not construct Jenkins payload.",
    });
  }
  return data;
};

export async function startGradingRun({
  courseId,
  jenkinsPipelineName,
  netIds,
  isoTimestamp,
  type,
  gradingRunId,
  jenkinsBaseUrl,
  courseTimezone,
  jenkinsToken,
  expectedCommitHash,
  logger,
}: StartGradingRunInputs) {
  gradingRunId = gradingRunId || uuid4();
  const jenkinsJobUrl = `${jenkinsBaseUrl}/job/${jenkinsPipelineName}/buildWithParameters`;
  const agDateTime = moment(isoTimestamp)
    .tz(courseTimezone)
    .format("YYYY-MM-DD HH:mm:ss");
  const params = getJenkinsParams({
    courseId,
    netIds,
    type,
    gradingRunId,
    agDateTime,
    logger,
    expectedCommitHash
  });
  const url = `${jenkinsJobUrl}?${new URLSearchParams(JSON.parse(JSON.stringify(params))).toString()}`;
  const result = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${jenkinsToken}`,
      "Content-Type": "application/json",
    },
  });
  if (result.status > 299) {
    logger.error(
      `Jenkins failed to start (status ${result.status}): ${await result.text()}`,
    );
    throw new GradingError({
      message: `Jenkins replied with status code ${result.status}`,
    });
  }
}
