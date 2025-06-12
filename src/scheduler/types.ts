import pino from "pino";
import { Job } from "../generated/prisma/client.js";
import { FastifyBaseLogger } from "fastify";

export type JobHandler = (
  job: Job,
  logger: pino.Logger | FastifyBaseLogger,
) => Promise<void>;

export interface JobRepository {
  lookaheadMinutes: number;
  findPendingJobs(): Promise<Job[]>;
  findJobById(id: string): Promise<Job | null>;
  createJob(job: Partial<Job>): Promise<Job>;
  updateJob(id: string, data: Partial<Job>): Promise<Job>;
  deleteJob(id: string): Promise<void>;
  setGracePeriodMs(gracePeriodMs: number): void;
}

export interface BaseJobStatus {
  PENDING: string;
  RUNNING: string;
  COMPLETED: string;
  FAILED: string;
  CANCELLED: string;
  INFRA_ERROR: string;
}

export type BaseJob = {
  name: string;
  id: string;
  payload: string;
  scheduledAt: Date;
  startedAt: Date | null;
  status: BaseJobStatus;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  failedAt: Date | null;
};
