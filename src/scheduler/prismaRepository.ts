import moment from "moment-timezone";
import {
  PrismaClient,
  Prisma,
  Job,
  JobStatus,
} from "../generated/prisma/client.js";
import { JobRepository } from "./types.js";

// Define a type for clients that can be either PrismaClient or a transaction client
type PrismaTransactionClient = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

export class PrismaJobRepository implements JobRepository {
  private client: PrismaTransactionClient;
  public lookaheadMinutes: number;
  private gracePeriodMs: number;

  constructor(
    client?: PrismaClient | PrismaTransactionClient,
    lookaheadMinutes?: number,
  ) {
    this.client = client || new PrismaClient();
    this.lookaheadMinutes = lookaheadMinutes || 10;
    this.gracePeriodMs = 0;
  }
  setGracePeriodMs(gracePeriodMs: number) {
    this.gracePeriodMs = gracePeriodMs;
  }
  /**
   * Find all pending jobs scheduled in the future
   */
  async findPendingJobs(): Promise<Job[]> {
    return this.client.job.findMany({
      where: {
        status: JobStatus.PENDING,
        scheduledAt: {
          gte: moment().subtract({ milliseconds: this.gracePeriodMs }).toDate(),
          lte: moment().add({ minutes: this.lookaheadMinutes }).toDate(),
        },
        startedAt: null,
      },
      orderBy: {
        scheduledAt: "asc",
      },
    });
  }

  async findJobById(id: string): Promise<Job | null> {
    return this.client.job.findUnique({
      where: { id },
    });
  }

  async createJob(job: Partial<Job>): Promise<Job> {
    return this.client.job.create({
      data: job as Prisma.JobCreateInput,
    });
  }

  async updateJob(id: string, data: Partial<Job>): Promise<Job> {
    return this.client.job.update({
      where: { id },
      data: data as Prisma.JobUpdateInput,
    });
  }

  async deleteJob(id: string): Promise<void> {
    await this.client.job.delete({
      where: { id },
    });
  }

  /**
   * Find jobs that need to be reprocessed after a server restart
   * (Jobs that were running when the server shut down)
   */
  async findInterruptedJobs(): Promise<Job[]> {
    return this.client.job.findMany({
      where: {
        status: JobStatus.RUNNING,
      },
    });
  }

  /**
   * Find jobs in a specific status
   */
  async findJobsByStatus(status: JobStatus): Promise<Job[]> {
    return this.client.job.findMany({
      where: { status },
    });
  }

  /**
   * Find jobs by name/type
   */
  async findJobsByName(name: string): Promise<Job[]> {
    return this.client.job.findMany({
      where: { name },
    });
  }

  /**
   * Get job stats by status
   */
  async getJobStats(): Promise<Record<JobStatus, number>> {
    const stats = await this.client.job.groupBy({
      by: ["status"],
      _count: {
        status: true,
      },
    });

    // Convert to record format
    const result = Object.values(JobStatus).reduce(
      (acc, status) => {
        acc[status] = 0;
        return acc;
      },
      {} as Record<JobStatus, number>,
    );

    // Fill in actual counts
    for (const stat of stats) {
      result[stat.status] = stat._count.status;
    }

    return result;
  }

  /**
   * Execute operations within a transaction
   */
  async withTransaction<T>(
    callback: (txRepo: PrismaJobRepository) => Promise<T>,
  ): Promise<T> {
    // Only support transactions if we have a full PrismaClient
    if (!("$transaction" in this.client)) {
      throw new Error("Cannot start a transaction from a transaction client");
    }

    return (this.client as PrismaClient).$transaction(async (tx) => {
      // Create a new repository with the transaction client
      const txRepo = new PrismaJobRepository(tx);
      return callback(txRepo);
    });
  }
}
