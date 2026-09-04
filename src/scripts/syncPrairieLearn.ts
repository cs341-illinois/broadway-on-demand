// Pulls the latest gradebook from PrairieLearn for a course and upserts it
// into the database. Run manually by staff, or wired into an external
// cron/CI job. See the "PrairieLearn sync" section of the unified gradebook
// plan for why this is a script rather than a scheduled in-app Job.
//
// Usage: npx tsx src/scripts/syncPrairieLearn.ts <courseId>
import dotenv from "dotenv";
dotenv.config();
if (!process.env.DATABASE_URL) {
  throw new Error(
    "Failed to find DATABASE_URL environment variable to connect to database!",
  );
}

import pino from "pino";
import { PrismaClient } from "../generated/prisma/client.js";
import { syncPrairieLearnGrades } from "../functions/prairieLearn.js";

async function main() {
  const courseId = process.argv[2];
  if (!courseId) {
    console.error("Usage: npx tsx src/scripts/syncPrairieLearn.ts <courseId>");
    process.exit(1);
  }

  const prismaClient = new PrismaClient();
  const logger = pino.pino({ level: process.env.LOG_LEVEL || "info" });

  const summary = await syncPrairieLearnGrades({ courseId, prismaClient, logger });

  console.log(`PrairieLearn sync complete for course '${courseId}':`);
  console.log(`  Assignments created: ${summary.assignmentsCreated}`);
  console.log(`  Assignments updated: ${summary.assignmentsUpdated}`);
  console.log(`  Grades upserted: ${summary.gradesUpserted}`);
  if (summary.skippedNetIds.length > 0) {
    console.warn(
      `  Skipped (not on roster): ${summary.skippedNetIds.join(", ")}`,
    );
  }

  await prismaClient.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
