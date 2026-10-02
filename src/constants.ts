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

// Total number of Lab partner rounds tracked per course. Rounds are
// generated on demand by an admin, not derived from a date.
export const PARTNER_MAX_ROUNDS = 4;

// createdBy/archivedBy sentinel for the one-time historical backfill script
// (src/scripts/importPartnerGroups.ts), as opposed to a real staff/admin netId.
export const PARTNER_IMPORT_SYSTEM_ACTOR = "system-import";

// Interview clinic room blocks are split into slots of this length.
export const CLINIC_SLOT_MINUTES = 30;
// Students may cancel their team's clinic booking only until this many hours
// before the slot starts; after that only staff can cancel.
export const CLINIC_STUDENT_CANCEL_CUTOFF_HOURS = 24;
// Upper bound on a single room booking, to catch date-entry typos.
export const CLINIC_MAX_BLOCK_HOURS = 12;
