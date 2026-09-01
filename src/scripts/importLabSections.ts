// Ingests a manually-curated netid -> lab section CSV (see cleaned_roster.csv
// for the expected shape: a `netid` column and a `Section` column) into the
// database, patches the extended `netid,section` roster to the course's
// roster repo on GitHub, and schedules the semester's PARTNER_ROTATION jobs
// (one per PARTNER_ROTATION_WEEKS-long window from Course.firstLabDate
// through Course.courseCutoff) so lab partner pairings start rotating
// automatically. Safe to re-run: DB updates are idempotent upserts of
// labSection, and already-scheduled rotation jobs for a boundary are not
// duplicated.
//
// Usage: npx tsx src/scripts/importLabSections.ts <courseId> <path-to-csv>
import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { createClient, type RedisClientType } from "redis";
import moment from "moment-timezone";
import pino from "pino";
import dotenv from "dotenv";
dotenv.config();
if (!process.env.DATABASE_URL) {
  throw new Error(
    "Failed to find DATABASE_URL environment variable to connect to database!",
  );
}
if (!process.env.REDIS_URL) {
  throw new Error(
    "Failed to find REDIS_URL environment variable to connect to Redis!",
  );
}

import { PrismaClient, JobType, Role } from "../generated/prisma/client.js";
import { overwriteRosterToGithub } from "../functions/github.js";
import { PrismaJobRepository } from "../scheduler/prismaRepository.js";
import {
  PARTNER_ROTATION_ASSIGNMENT_ID,
  PARTNER_ROTATION_WEEKS,
} from "../constants.js";

type CsvRow = { netid: string; section: string };

function parseRoster(csvContent: string): CsvRow[] {
  const rows = parse(csvContent, {
    columns: (header: string[]) => header.map((h) => h.trim().toLowerCase()),
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];
  return rows
    .map((row) => ({ netid: row.netid, section: row.section }))
    .filter((row) => row.netid && row.section);
}

async function main() {
  const [courseId, filePath] = process.argv.slice(2);
  if (!courseId || !filePath) {
    console.error(
      "Usage: npx tsx src/scripts/importLabSections.ts <courseId> <path-to-csv>",
    );
    process.exit(1);
  }

  const rows = parseRoster(readFileSync(filePath, "utf-8"));
  if (rows.length === 0) {
    throw new Error(`No usable rows found in ${filePath}.`);
  }

  const prismaClient = new PrismaClient();
  const course = await prismaClient.course
    .findUniqueOrThrow({
      where: { id: courseId },
      select: {
        firstLabDate: true,
        courseCutoff: true,
        githubOrg: true,
        githubToken: true,
        rosterRepo: true,
      },
    })
    .catch(() => {
      throw new Error(`No course with id '${courseId}' exists.`);
    });

  const skippedNetIds: string[] = [];
  let updated = 0;

  await prismaClient.$transaction(async (tx) => {
    for (const row of rows) {
      const result = await tx.users.updateMany({
        where: { courseId, netId: row.netid, role: Role.STUDENT, enabled: true },
        data: { labSection: row.section },
      });
      if (result.count === 0) {
        skippedNetIds.push(row.netid);
      } else {
        updated += 1;
      }
    }
  });

  const rosterEntriesDirty = await prismaClient.users.findMany({
    select: { netId: true, labSection: true },
    where: { courseId, enabled: true, role: Role.STUDENT },
  });
  const rosterEntries = rosterEntriesDirty.sort((a, b) =>
    a.netId < b.netId ? -1 : a.netId > b.netId ? 1 : 0,
  );

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("REDIS_URL environment variable is not set!");
  }
  const logger = pino.pino({ level: process.env.LOG_LEVEL || "info" });
  // The explicit cast works around a known TS generic-instantiation quirk in
  // the `redis` v5 typings where a fresh createClient() call and the bare
  // RedisClientType alias (used by overwriteRosterToGithub's signature) are
  // structurally identical but not provably assignable to the type checker.
  const redisClient = createClient({ url: redisUrl }) as unknown as RedisClientType;
  await redisClient.connect();
  try {
    await overwriteRosterToGithub({
      redisClient,
      rosterEntries,
      commitMessage: `Import lab sections from ${filePath}`,
      githubToken: course.githubToken,
      orgName: course.githubOrg,
      repoName: course.rosterRepo,
      logger,
    });
  } finally {
    await redisClient.quit();
  }

  const jobRepo = new PrismaJobRepository(prismaClient);
  let boundariesScheduled = 0;
  let boundariesSkipped = 0;
  let cursor = moment(course.firstLabDate);
  while (cursor.isSameOrBefore(course.courseCutoff)) {
    const boundaryDate = cursor.toDate();
    const existingJob = await prismaClient.job.findFirst({
      where: {
        courseId,
        type: JobType.PARTNER_ROTATION,
        dueAt: boundaryDate,
      },
      select: { id: true },
    });
    if (existingJob) {
      boundariesSkipped += 1;
    } else {
      await jobRepo.createJob({
        name: "partnerRotation",
        courseId,
        assignmentId: PARTNER_ROTATION_ASSIGNMENT_ID,
        netId: ["_ALL_"],
        type: JobType.PARTNER_ROTATION,
        dueAt: boundaryDate,
        scheduledAt: boundaryDate,
      });
      boundariesScheduled += 1;
    }
    cursor = cursor.clone().add(PARTNER_ROTATION_WEEKS, "weeks");
  }

  console.log(`Lab section import complete for course '${courseId}':`);
  console.log(`  Students updated: ${updated}`);
  if (skippedNetIds.length > 0) {
    console.warn(
      `  Skipped (not an enabled student on roster): ${skippedNetIds.join(", ")}`,
    );
  }
  console.log(`  Roster repo patched: ${course.githubOrg}/${course.rosterRepo}`);
  console.log(
    `  Partner rotation jobs scheduled: ${boundariesScheduled} (already scheduled, skipped: ${boundariesSkipped})`,
  );

  await prismaClient.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
