import { EventEmitter } from "events";
import { JobStatus, Job, JobType } from "@prisma/client";
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
    this.pollingIntervalMs = options.pollingIntervalMs || 30 * 1000; // Default: 30 seconds
    this.gracePeriodMs = options.gracePeriodMs || 240 * 60 * 1000; // Default: 4 hours
    this.logger = (options.logger || pino.pino({})).child({
      module: "scheduler",
    });
  }

  public registerHandler(jobName: string, handler: JobHandler): void {
    this.jobHandlers.set(jobName, handler);
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    // Load all pending jobs from the database
    await this.loadPendingJobs();

    // Start polling for new jobs
    this.pollingInterval = setInterval(async () => {
      await this.loadPendingJobs();
    }, this.pollingIntervalMs);

    this.logger.info("Job scheduler started");
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) return;

    // Clear the polling interval
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }

    // Clear all scheduled timers
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();

    this.isRunning = false;
    this.logger.info("Job scheduler stopped");
  }

  private async loadPendingJobs(): Promise<void> {
    try {
      const jobs = await this.repository.findPendingJobs();

      for (const job of jobs) {
        this.scheduleJobExecution(job);
      }
    } catch (error) {
      this.logger.error("Error loading pending jobs:", error);
    }
  }

  private scheduleJobExecution(job: Job): void {
    // Skip if this job is already scheduled
    if (this.timers.has(job.id)) return;
    if (!job.scheduledAt) return;

    const now = new Date();
    const scheduledTime = new Date(job.scheduledAt);
    const delay = scheduledTime.getTime() - now.getTime();

    if (delay <= 0) {
      if (-delay > this.gracePeriodMs) {
        this.logger.warn(
          `Could not execute past-due job ${job.id} as delay ${-delay} > gracePeriodMs ${this.gracePeriodMs}`,
        );
        return;
      }
      this.logger.warn(`Executing past-due job ${job.id}`);
      this.executeJob(job.id).catch((err) =>
        this.logger.error(`Failed to execute past-due job ${job.id}:`, err),
      );
      return;
    }

    // Schedule the job
    const timer = setTimeout(() => {
      this.executeJob(job.id).catch((err) =>
        this.logger.error(`Failed to execute scheduled job ${job.id}:`, err),
      );
    }, delay);

    // Store the timer reference
    this.timers.set(job.id, timer);
    this.logger.info(
      `Job ${job.id} scheduled for ${scheduledTime.toISOString()}`,
    );
  }

  /**
   * Execute a job
   */
  private async executeJob(jobId: string): Promise<void> {
    try {
      // Get the job from the database
      const job = await this.repository.findJobById(jobId);

      if (!job || job.status !== JobStatus.PENDING) {
        return;
      }
      const childLogger = this.logger.child({ job: job.id });

      childLogger.info(`Executing job ${jobId}`);

      // Mark job as running
      await this.repository.updateJob(jobId, {
        status: JobStatus.RUNNING,
        runAt: new Date(),
      });

      // Remove the timer reference
      this.timers.delete(jobId);

      // Check if we have a handler for this job type
      const handler = this.jobHandlers.get(job.name);

      if (!handler) {
        this.logger.error("No handler found, emitting generic job event...");
        await this.repository.updateJob(jobId, {
          status: JobStatus.FAILED,
          completedAt: new Date(),
        });
        return;
      }

      try {
        // Execute the job handler
        await handler(job, childLogger);
        await this.repository.updateJob(jobId, {
          status: JobStatus.COMPLETED,
          completedAt: new Date(),
        });
        childLogger.info("Set info completed!");
      } catch (handlerError) {
        this.logger.error(`Error in job handler for ${jobId}:`, handlerError);

        await this.repository.updateJob(jobId, {
          status: JobStatus.FAILED,
          failedAt: new Date(),
        });

        this.logger.info(`Job ${jobId} failed.`);
      }
    } catch (error) {
      this.logger.error(`Error executing job ${jobId}:`, error);
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
      users: string[];
      type: JobType;
    },
    scheduledAt: Date | string,
  ): Promise<Job> {
    try {
      // Create a new job in the database
      const job = await this.repository.createJob({
        ...payload,
        name,
        scheduledAt: new Date(scheduledAt),
        status: JobStatus.PENDING,
      });

      // Schedule the job
      this.scheduleJobExecution(job);

      return job;
    } catch (error) {
      this.logger.error("Error scheduling new job:", error);
      throw error;
    }
  }

  /**
   * Cancel a job
   */
  public async cancelJob(jobId: string): Promise<Job> {
    try {
      // Get the timer for this job
      const timer = this.timers.get(jobId);

      // Clear the timer if it exists
      if (timer) {
        clearTimeout(timer);
        this.timers.delete(jobId);
      }

      // Update the job status in the database
      const job = await this.repository.updateJob(jobId, {
        status: JobStatus.CANCELLED,
      });

      return job;
    } catch (error) {
      this.logger.error(`Error cancelling job ${jobId}:`, error);
      throw error;
    }
  }
}
