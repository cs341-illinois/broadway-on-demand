import { JobStatus } from "./generated/prisma/enums.js";


export const TERMINAL_STATE_VALID_TRANSITIONS = [JobStatus.PENDING, JobStatus.RUNNING];
export const VALID_JOB_STATUS_TRANSITIONS: Record<JobStatus | 'none', JobStatus[]> = {
  'none': [JobStatus.PENDING, JobStatus.RUNNING],
  [JobStatus.PENDING]: [JobStatus.PENDING, JobStatus.INFRA_ERROR, JobStatus.FAILED, JobStatus.RUNNING],
  [JobStatus.RUNNING]: [JobStatus.RUNNING, JobStatus.INFRA_ERROR, JobStatus.FAILED, JobStatus.COMPLETED, JobStatus.TIMEOUT],
  [JobStatus.COMPLETED]: [JobStatus.COMPLETED, ...TERMINAL_STATE_VALID_TRANSITIONS],
  [JobStatus.INFRA_ERROR]: [JobStatus.INFRA_ERROR, ...TERMINAL_STATE_VALID_TRANSITIONS],
  [JobStatus.FAILED]: [JobStatus.FAILED, ...TERMINAL_STATE_VALID_TRANSITIONS],
  [JobStatus.TIMEOUT]: [JobStatus.TIMEOUT, ...TERMINAL_STATE_VALID_TRANSITIONS],
  [JobStatus.CANCELLED]: [JobStatus.CANCELLED, ...TERMINAL_STATE_VALID_TRANSITIONS]
}
