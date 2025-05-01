import pino from "pino";
import { Job } from "../../generated/prisma/index.js";
import { FastifyBaseLogger } from "fastify";

export type JobHandler = (
  job: Job,
  logger: pino.Logger | FastifyBaseLogger,
) => Promise<void>;

export interface JobRepository {
  findPendingJobs(): Promise<Job[]>;
  findJobById(id: string): Promise<Job | null>;
  createJob(job: Partial<Job>): Promise<Job>;
  updateJob(id: string, data: Partial<Job>): Promise<Job>;
  deleteJob(id: string): Promise<void>;
}

export interface BaseJobStatus {
  PENDING: string;
  RUNNING: string;
  COMPLETED: string;
  FAILED: string;
  CANCELLED: string;
  RECOVERY: string;
}

export type BaseJob = {
  name: string;
  id: string;
  payload: string;
  scheduledAt: Date;
  runAt: Date | null;
  status: BaseJobStatus;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  failedAt: Date | null;
  recoveryUntil: Date | null;
};
