import { JobStatus } from "./generated/prisma/enums.js";

export const TERMINAL_STATE_VALID_TRANSITIONS = [
  JobStatus.PENDING,
  JobStatus.RUNNING,
];
export const VALID_JOB_STATUS_TRANSITIONS: Record<
  JobStatus | "none",
  JobStatus[]
> = {
  none: [JobStatus.PENDING, JobStatus.RUNNING, JobStatus.INFRA_ERROR],
  [JobStatus.PENDING]: [
    JobStatus.PENDING,
    JobStatus.INFRA_ERROR,
    JobStatus.FAILED,
    JobStatus.RUNNING,
  ],
  [JobStatus.RUNNING]: [
    JobStatus.RUNNING,
    JobStatus.INFRA_ERROR,
    JobStatus.FAILED,
    JobStatus.COMPLETED,
    JobStatus.TIMEOUT,
  ],
  [JobStatus.COMPLETED]: [
    JobStatus.COMPLETED,
    ...TERMINAL_STATE_VALID_TRANSITIONS,
  ],
  [JobStatus.INFRA_ERROR]: [
    JobStatus.INFRA_ERROR,
    ...TERMINAL_STATE_VALID_TRANSITIONS,
  ],
  [JobStatus.FAILED]: [JobStatus.FAILED, ...TERMINAL_STATE_VALID_TRANSITIONS],
  [JobStatus.TIMEOUT]: [JobStatus.TIMEOUT, ...TERMINAL_STATE_VALID_TRANSITIONS],
  [JobStatus.CANCELLED]: [
    JobStatus.CANCELLED,
    ...TERMINAL_STATE_VALID_TRANSITIONS,
  ],
};

// How long stats are cached for in Redis
export const STATS_EXPIRY_SECS = 1200;
// How % wide the histograms are for assignment stats
export const HISTOGRAM_BIN_WIDTH = 10;
// How % wide the histogram column markers are for assignment stats
export const HISTOGRAM_COL_MARKER_HEIGHT = 25;

// How often Lab partner pairings are re-shuffled, in weeks, relative to
// Course.firstLabDate.
export const PARTNER_ROTATION_WEEKS = 4;

// Sentinel assignmentId used for scheduled Jobs that aren't tied to a real
// Assignment row (mirrors the existing "_ALL_" netId sentinel convention).
export const PARTNER_ROTATION_ASSIGNMENT_ID = "_partner_rotation_";

// createdBy sentinel for auto-generated (as opposed to staff-edited) partner groups.
export const PARTNER_GROUP_SYSTEM_CREATOR = "system";
