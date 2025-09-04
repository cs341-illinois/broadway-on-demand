import { EventEmitter } from "events";
import { JobStatus, type PrismaClient } from "../generated/prisma/client.js";
import pino from "pino";
import { type FastifyBaseLogger } from "fastify";
import { retryAsync } from "../functions/utils.js";
import { InternalServerError } from "../errors/index.js";

export type JenkinsQueueItem = {
  cancelled?: boolean;
  executable?: {
    url: string;
  } | null;
};

export type UnreportedJob = {
  id: string;
  queueUrl: string | null;
  course: {
    jenkinsToken: string | null;
  };
};

export type JenkinsBuildItem = {
  result: 'SUCCESS' | 'UNSTABLE' | 'FAILURE' | 'NOT_BUILT' | 'ABORTED' | null;
};

export class JobReconciler extends EventEmitter {
  private isRunning: boolean = false;
  private pollingIntervalMs: number;
  private logger: pino.Logger | FastifyBaseLogger;
  private prismaClient: PrismaClient;
  private pollingInterval?: NodeJS.Timeout;



  constructor(
    prismaClient: PrismaClient,
    options: {
      pollingIntervalMs?: number; // Polling interval in milliseconds
      gracePeriodMs?: number; // Grace period for pending job execution in milliseconds
      logger?: pino.Logger | FastifyBaseLogger;
    } = {},
  ) {
    super();
    this.prismaClient = prismaClient;
    this.pollingIntervalMs = options.pollingIntervalMs || 20 * 1000; // Default: 20 seconds
    this.logger = (options.logger || pino.pino({})).child({
      module: "reconciler",
    });
  }
  public async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.logger.info("Starting job reconciler...");
    await this.reconcileJobs();
    this.pollingInterval = setInterval(async () => {
      this.logger.debug("Polling for pending jobs...");
      await this.reconcileJobs();
    }, this.pollingIntervalMs);

    this.logger.info(
      `Job reconciler started. Polling every ${this.pollingIntervalMs / 1000}s.`,
    );
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.logger.info("Stopping job reconciler...");

    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = undefined;
    }

    this.isRunning = false;
    this.logger.info(
      `Job reconciler stopped.`,
    );
  }

  public async reconcileJobs() {
    const unreportedJobs = await this.getUnreportedJobs();
    if (!unreportedJobs || unreportedJobs.length === 0) {
      this.logger.debug("No unreported jobs to reconcile.");
      return;
    }
    const statusCheckPromises = unreportedJobs.map(async (job) => {
      const newStatus = await this.getQueuedJobStatus(job);
      return { jobId: job.id, newStatus };
    });

    const results = await Promise.allSettled(statusCheckPromises);
    const jobsToUpdate = results
      .filter((res): res is PromiseFulfilledResult<{ jobId: string; newStatus: JobStatus }> =>
        res.status === 'fulfilled' &&
        res.value.newStatus !== null &&
        res.value.newStatus !== JobStatus.PENDING
      )
      .map(res => res.value);

    if (jobsToUpdate.length === 0) {
      this.logger.debug("Reconciliation complete. No jobs required a status update.");
      return;
    }

    this.logger.debug(`Found ${jobsToUpdate.length} job(s) to update.`);
    const updateOperations = jobsToUpdate.map(job => {
      return this.prismaClient.job.update({
        where: { id: job.jobId, status: JobStatus.PENDING }, // if the job moved past PENDING while we do this, then do nothing
        data: { status: job.newStatus },
      });
    });

    try {
      const transactionResult = await this.prismaClient.$transaction(updateOperations);
      this.logger.debug(`Successfully updated ${transactionResult.length} job(s) in the database.`);
    } catch (error) {
      this.logger.error({ error }, "An error occurred during the job update transaction.");
    }
  }
  private async getUnreportedJobs(): Promise<UnreportedJob[] | null> {
    this.logger.debug("Getting unreported jobs");
    const pendingJobs = await this.prismaClient.job.findMany({
      where: {
        status: JobStatus.PENDING,
        queueUrl: { not: null }
      },
      select: {
        id: true,
        courseId: true,
        assignmentId: true,
        queueUrl: true,
        course: {
          select: {
            jenkinsToken: true
          }
        }
      }
    }).catch(e => this.logger.error(e));
    if (pendingJobs) {
      this.logger.debug(`Found ${pendingJobs.length} unreported jobs.`);
    }
    return pendingJobs || null;
  }
  public async getQueuedJobStatus(job: UnreportedJob): Promise<JobStatus | null> {
    if (!job.queueUrl || !job.course.jenkinsToken) {
      this.logger.warn({ jobId: job.id }, "Job is missing queueUrl or course is missing Jenkins token.");
      return null;
    }
    const authHeader = 'Basic ' + job.course.jenkinsToken;
    const headers = { 'Authorization': authHeader };

    try {
      const queueApiUrl = job.queueUrl + 'api/json';
      const queueResponse = await retryAsync(async () => {
        let response;
        try {
          response = await fetch(queueApiUrl, { headers });
        } catch (error) {
          this.logger.warn({ error, jobId: job.id }, "Network error during fetch; rethrowing to retry.");
          throw error;
        }

        if (response.status >= 500 || response.status === 404) {
          const error = new InternalServerError({ message: "Failed to get queue item status" });
          this.logger.warn({ status: response.status, jobId: job.id }, `HTTP ${response.status} error; rethrowing to retry.`);
          throw error;
        }
        return response;
      }, { retries: 3, maxDelayMs: 2000 });

      if (!queueResponse.ok) {
        this.logger.error(
          { jobId: job.id, status: queueResponse.status, url: queueApiUrl },
          "Failed to fetch job status from Jenkins queue."
        );
        return null;
      }

      const queueData = await queueResponse.json() as JenkinsQueueItem;
      if (queueData.cancelled) {
        this.logger.debug({ jobId: job.id }, "Job was cancelled in the queue.");
        return JobStatus.CANCELLED;
      }

      if (queueData.executable?.url) {
        const buildApiUrl = queueData.executable.url + 'api/json';
        const buildResponse = await retryAsync(async () => {
          let response;
          try {
            response = await fetch(buildApiUrl, { headers });
          } catch (error) {
            this.logger.warn({ error, jobId: job.id }, "Network error during build fetch; rethrowing to retry.");
            throw error;
          }

          if (response.status >= 500 || response.status === 404) {
            const error = new InternalServerError({ message: `Jenkins returned a transient error: ${response.status}` });
            this.logger.warn({ status: response.status, jobId: job.id }, `HTTP ${response.status} error on build URL; rethrowing to retry.`);
            throw error;
          }
          return response;
        }, { retries: 3, maxDelayMs: 2000 });


        if (!buildResponse.ok) {
          this.logger.error(
            { jobId: job.id, status: buildResponse.status, url: buildApiUrl },
            "Failed to fetch job status from Jenkins build URL."
          );
          return null;
        }

        const buildData = await buildResponse.json() as JenkinsBuildItem;

        const result = buildData.result;
        if (result === 'FAILURE' || result === "ABORTED") {
          this.logger.debug({ jobId: job.id, result }, "Job build resulted in an error state.");
          return JobStatus.INFRA_ERROR;
        }
        return null;
      }
      this.logger.debug({ jobId: job.id }, "Job is currently queued.");
      return JobStatus.PENDING;
    } catch (error) {
      this.logger.error({ jobId: job.id, error }, "An exception occurred while polling Jenkins.");
      return null;
    }
  }
}
