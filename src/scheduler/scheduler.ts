import { EventEmitter } from "events";
import { JobStatus, Job, JobType } from "../generated/prisma/client.js";
import { JobHandler, JobRepository } from "./types.js";
import pino from "pino";
import { FastifyBaseLogger } from "fastify";

export class JobScheduler extends EventEmitter {
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private isRunning: boolean = false;
  private pollingInterval?: NodeJS.Timeout;
  private jobHandlers: Map<string, JobHandler> = new Map();
  private pollingIntervalMs: number;
  private gracePeriodMs: number;
  private logger: pino.Logger | FastifyBaseLogger;

  constructor(
    private repository: JobRepository,
    options: {
      pollingIntervalMs?: number; // Polling interval in milliseconds
      gracePeriodMs?: number; // Grace period for pending job execution in milliseconds
      logger?: pino.Logger | FastifyBaseLogger;
    } = {},
  ) {
    super();
    this.pollingIntervalMs = options.pollingIntervalMs || 10 * 1000; // Default: 10 seconds
    this.gracePeriodMs = options.gracePeriodMs || 240 * 60 * 1000; // Default: 4 hours
    this.logger = (options.logger || pino.pino({})).child({
      module: "scheduler",
    });
    this.repository.setGracePeriodMs(this.gracePeriodMs);
  }

  public registerHandler(jobType: string, handler: JobHandler): void {
    this.jobHandlers.set(jobType, handler);
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.logger.info("Starting job scheduler...");

    // Load all pending jobs from the database
    await this.loadPendingJobs();

    // Start polling for new jobs
    this.pollingInterval = setInterval(async () => {
      this.logger.debug("Polling for pending jobs...");
      await this.loadPendingJobs();
    }, this.pollingIntervalMs);

    this.logger.info(
      `Job scheduler started. Polling every ${this.pollingIntervalMs / 1000}s.`,
    );
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.logger.info("Stopping job scheduler...");

    // Clear the polling interval
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = undefined;
    }

    // Clear all scheduled timers
    const clearedTimersCount = this.timers.size;
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();

    this.isRunning = false;
    this.logger.info(
      `Job scheduler stopped. Cleared ${clearedTimersCount} timers.`,
    );
  }

  /**
   * Refreshes the scheduler's state with the database.
   * This will cancel all current locally scheduled jobs and reload them from the database.
   */
  public async refreshJobs(): Promise<void> {
    this.logger.info("Refreshing job scheduler state with the database...");

    // 1. Clear all existing locally scheduled timers
    const currentTimersCount = this.timers.size;
    if (currentTimersCount > 0) {
      for (const timer of this.timers.values()) {
        clearTimeout(timer);
      }
      this.timers.clear();
      this.logger.info(`Cleared ${currentTimersCount} existing local timers.`);
    } else {
      this.logger.info("No local timers to clear.");
    }

    // 2. Load and schedule all pending jobs from the database
    // this.loadPendingJobs() will fetch from DB and call scheduleJobExecution for each.
    // Since timers are now empty, scheduleJobExecution will attempt to schedule all pending jobs.
    if (this.isRunning) {
      await this.loadPendingJobs();
      this.logger.info(
        `Job scheduler refresh completed. Currently ${this.timers.size} jobs scheduled.`,
      );
    } else {
      this.logger.warn(
        "Job scheduler is not running. Refresh will load jobs, but they won't be actively polled or new ones scheduled until started.",
      );
      // Optionally, you might still want to load them if the intention is to prepare for a later start
      // await this.loadPendingJobs();
      // this.logger.info(`Jobs loaded after refresh (scheduler stopped). ${this.timers.size} jobs ready if started.`);
    }
  }

  private async loadPendingJobs(): Promise<void> {
    this.logger.trace(
      `Loading pending jobs from repository within the next ${this.repository.lookaheadMinutes} minutes...`,
    );
    try {
      // 1. Get current local job IDs before fetching from the database
      const localJobIdsBeforeFetch = new Set(this.timers.keys());
      this.logger.trace(
        `Local timers before fetch: ${localJobIdsBeforeFetch.size} jobs.`,
      );

      // 2. Fetch all PENDING jobs from the database
      const jobs = await this.repository.findPendingJobs();
      this.logger.trace(`Found ${jobs.length} pending jobs in repository.`);

      // 3. Create a set of IDs from the fetched pending jobs
      const fetchedJobIds = new Set(jobs.map((job) => job.id));

      // 4. Identify jobs that are in local timers but are NOT in the fetched pending jobs
      const jobIdsToRemoveFromLocal = new Set<string>();
      for (const localJobId of localJobIdsBeforeFetch) {
        if (!fetchedJobIds.has(localJobId)) {
          jobIdsToRemoveFromLocal.add(localJobId);
        }
      }

      // 5. Remove timers for jobs no longer pending in the database
      // This handles cases where jobs were completed, failed, cancelled, or deleted externally.
      if (jobIdsToRemoveFromLocal.size > 0) {
        this.logger.info(
          `Identified ${jobIdsToRemoveFromLocal.size} jobs in local timers that are no longer pending in DB. Removing local timers.`,
        );
        for (const jobId of jobIdsToRemoveFromLocal) {
          const timer = this.timers.get(jobId);
          if (timer) {
            clearTimeout(timer);
            this.timers.delete(jobId);
            this.logger.debug(
              `Cleared timer for job ${jobId} as it is no longer pending in DB.`,
            );
          }
        }
      } else {
        this.logger.trace(
          "No local timers found for jobs no longer pending in DB.",
        );
      }

      // 6. Schedule execution for all fetched pending jobs.
      // scheduleJobExecution will only schedule jobs that are not already in this.timers
      for (const job of jobs) {
        this.scheduleJobExecution(job);
      }

      this.logger.debug(
        `Currently ${this.timers.size} jobs in local timer queue.`,
      );
    } catch (error) {
      this.logger.error({ err: error }, "Error loading pending jobs");
    }
  }

  private scheduleJobExecution(job: Job): void {
    // Skip if this job is already scheduled (e.g. by a concurrent call or if already processed in this load cycle)
    if (this.timers.has(job.id)) {
      this.logger.trace(
        `Job ${job.id} is already in the local timer queue. Skipping scheduling.`,
      );
      return;
    }
    if (!job.scheduledAt) {
      this.logger.warn(
        { jobId: job.id },
        "Job has no scheduledAt time. Cannot schedule.",
      );
      return;
    }

    const now = new Date();
    const scheduledTime = new Date(job.scheduledAt);
    const delay = scheduledTime.getTime() - now.getTime();

    const jobDetails = {
      jobId: job.id,
      jobName: job.name,
      scheduledAt: scheduledTime.toISOString(),
      delayMs: delay,
    };

    if (delay <= 0) {
      // Job is past due
      if (-delay > this.gracePeriodMs) {
        this.logger.warn(
          { ...jobDetails, gracePeriodMs: this.gracePeriodMs },
          `Could not execute past-due job ${job.id} as delay ${-delay}ms > gracePeriodMs ${this.gracePeriodMs}ms. Marking as potentially stale or missed.`,
        );
        // Potentially mark as FAILED or CANCELLED here if it's too old to run
        // For now, we just don't schedule it.
        return;
      }
      this.logger.warn(
        jobDetails,
        `Executing past-due job ${job.id} immediately (delay was ${delay}ms).`,
      );
      // Execute immediately but asynchronously
      this.executeJob(job.id).catch((err) =>
        this.logger.error(
          { err, jobId: job.id },
          `Failed to execute past-due job ${job.id} during scheduling`,
        ),
      );
      return;
    }

    // Schedule the job
    const timer = setTimeout(() => {
      this.executeJob(job.id).catch((err) =>
        this.logger.error(
          { err, jobId: job.id },
          `Failed to execute scheduled job ${job.id} from timeout callback`,
        ),
      );
    }, delay);

    // Store the timer reference
    this.timers.set(job.id, timer);
    this.logger.info(
      jobDetails,
      `Job ${job.id} (${job.courseId}/${job.assignmentId}/${job.name}) scheduled for ${scheduledTime.toISOString()}`,
    );
  }

  /**
   * Execute a job
   */
  private async executeJob(jobId: string): Promise<void> {
    const childLogger = this.logger.child({ jobId });
    try {
      // Get the job from the database just before execution to ensure it's still valid
      const job = await this.repository.findJobById(jobId);

      if (!job) {
        childLogger.warn(
          "Job not found in repository at execution time. It might have been deleted.",
        );
        this.timers.delete(jobId); // Ensure local timer is gone if somehow still present
        return;
      }

      if (job.status !== JobStatus.PENDING) {
        childLogger.warn(
          { currentStatus: job.status },
          `Job ${jobId} is no longer PENDING (current status: ${job.status}). Skipping execution.`,
        );
        this.timers.delete(jobId); // Ensure local timer is gone
        return;
      }

      childLogger.info(`Executing job ${job.name} (ID: ${jobId})`);

      // Mark job as running
      await this.repository.updateJob(jobId, {
        status: JobStatus.RUNNING,
        startedAt: new Date(),
      });

      this.timers.delete(jobId); // Remove from local queue now that it's running

      const handler = this.jobHandlers.get(job.type);

      if (!handler) {
        childLogger.error(
          `No handler found for job type "${job.type}". Marking as INFRA_ERROR.`,
        );
        await this.repository.updateJob(jobId, {
          status: JobStatus.INFRA_ERROR,
          failedAt: new Date(),
        });
        this.emit("jobFailed", {
          job,
          error: new Error(`No handler for job type: ${job.type}`),
        });
        return;
      }

      try {
        await handler(job, childLogger);
        await this.repository.updateJob(jobId, {
          status: JobStatus.RUNNING,
        });
        childLogger.info(
          `Job ${job.name} (ID: ${jobId}) completed successfully.`,
        );
        this.emit("jobCompleted", job);
      } catch (handlerError: any) {
        childLogger.error(
          { err: handlerError },
          `Error in job handler for job ${job.name} (ID: ${jobId})`,
        );
        await this.repository.updateJob(jobId, {
          status: JobStatus.FAILED,
          failedAt: new Date(),
        });
        childLogger.info(`Job ${job.name} (ID: ${jobId}) marked as FAILED.`);
        this.emit("jobFailed", { job, error: handlerError });
      }
    } catch (error: any) {
      // Catch errors in the execution logic itself (e.g., database update failure)
      childLogger.error(
        { err: error },
        `Critical error during execution logic for job ${jobId}`,
      );
      // We may or may not have deleted the timer yet, ensure it's gone.
      this.timers.delete(jobId);
      // We don't know the state of the job in the DB at this point,
      // a subsequent loadPendingJobs will eventually clean it up if it stays pending.

      this.emit("jobError", { jobId, error });
    }
  }

  /**
   * Schedule a new job
   */
  public async scheduleJob(
    name: string,
    payload: {
      courseId: string;
      assignmentId: string;
      netId: string[];
      type: JobType;
      dueAt: Date;
    },
    scheduledAt: Date | string,
  ): Promise<Job> {
    this.logger.info(
      { jobName: name, scheduledAt: new Date(scheduledAt).toISOString() },
      "Attempting to schedule new job",
    );
    try {
      // Create a new job in the database
      const job = await this.repository.createJob({
        ...payload,
        name,
        scheduledAt: new Date(scheduledAt),
        status: JobStatus.PENDING,
      });
      this.logger.info(
        { jobId: job.id, jobName: name },
        "Job created in repository",
      );

      // Schedule the job for execution
      if (this.isRunning) {
        // Only schedule locally if the scheduler is running
        this.scheduleJobExecution(job);
      } else {
        this.logger.warn(
          { jobId: job.id },
          "Scheduler is not running, job created in DB but not scheduled locally.",
        );
      }

      this.emit("jobScheduled", job);
      return job;
    } catch (error) {
      this.logger.error(
        { err: error, jobName: name },
        "Error scheduling new job",
      );
      throw error; // Re-throw to allow caller to handle
    }
  }

  /**
   * Cancel a job
   */
  public async cancelJob(jobId: string): Promise<Job | null> {
    this.logger.info({ jobId }, `Attempting to cancel job ${jobId}`);
    try {
      // Clear local timer immediately if it exists
      const timer = this.timers.get(jobId);
      if (timer) {
        clearTimeout(timer);
        this.timers.delete(jobId);
        this.logger.info({ jobId }, `Cleared local timer for job ${jobId}`);
      } else {
        this.logger.debug(
          { jobId },
          `No local timer found for job ${jobId} (it might have already run, been cancelled, or not scheduled locally).`,
        );
      }

      // Check current job status in the database
      const jobExists = await this.repository.findJobById(jobId);
      if (!jobExists) {
        this.logger.warn(
          { jobId },
          `Job ${jobId} not found in repository. Cannot mark as CANCELLED.`,
        );
        // Even if not found, we cleared the local timer, so this is fine.
        return null;
      }

      // Update job status in the database if it's in a cancellable state
      if (
        jobExists.status === JobStatus.PENDING ||
        jobExists.status === JobStatus.RUNNING
      ) {
        this.logger.info(
          { jobId, currentStatus: jobExists.status },
          `Job ${jobId} is in cancellable state. Updating status to CANCELLED.`,
        );
        const job = await this.repository.updateJob(jobId, {
          status: JobStatus.CANCELLED,
        });
        this.logger.info(
          { jobId, newStatus: job.status },
          `Job ${jobId} status updated to CANCELLED in repository.`,
        );
        this.emit("jobCancelled", job);
        return job;
      } else {
        this.logger.warn(
          { jobId, currentStatus: jobExists.status },
          `Job ${jobId} is not in a cancellable state (current: ${jobExists.status}). No action taken in repository.`,
        );
        // Return the existing job with its current status
        return jobExists;
      }
    } catch (error) {
      this.logger.error({ err: error, jobId }, `Error cancelling job ${jobId}`);
      throw error;
    }
  }
}
