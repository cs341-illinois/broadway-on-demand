import { JobType } from "../../generated/prisma/index.js";
import { PrismaJobRepository } from "../scheduler/prismaRepository.js";

const jobRepo = new PrismaJobRepository();
await jobRepo.createJob({
  name: "runScheduledGradingJob",
  scheduledAt: new Date(Date.now() + 15000), // Schedule 1 minute from now,
  courseId: "cs341-fa25",
  assignmentId: "extreme_edge_cases",
  type: JobType.FINAL_GRADING,
});
