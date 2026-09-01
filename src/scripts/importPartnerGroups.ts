// One-time backfill of external partner pairings into a specific round. Goes
// through the same archiveAndCreateGroups() path the admin UI uses, so it's
// non-destructive and shows up in that section+round's history.
//
// CSV shape: two columns, `netid` and `groupId` - every row sharing the same
// groupId becomes one PartnerGroup (2 or 3 members). All members of a
// groupId must be enabled students in the same lab section.
//
// Usage: npx tsx src/scripts/importPartnerGroups.ts <courseId> <roundNumber> <path-to-csv>
import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import dotenv from "dotenv";
dotenv.config();
if (!process.env.DATABASE_URL) {
  throw new Error(
    "Failed to find DATABASE_URL environment variable to connect to database!",
  );
}

import { PrismaClient, Role } from "../generated/prisma/client.js";
import { archiveAndCreateGroups } from "../functions/partners.js";
import { PARTNER_IMPORT_SYSTEM_ACTOR, PARTNER_MAX_ROUNDS } from "../constants.js";

type CsvRow = { netid: string; groupid: string };

function parseCsv(csvContent: string): CsvRow[] {
  const rows = parse(csvContent, {
    columns: (header: string[]) => header.map((h) => h.trim().toLowerCase()),
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];
  return rows
    .map((row) => ({ netid: row.netid, groupid: row.groupid }))
    .filter((row) => row.netid && row.groupid);
}

async function main() {
  const [courseId, roundNumberRaw, filePath] = process.argv.slice(2);
  if (!courseId || !roundNumberRaw || !filePath) {
    console.error(
      "Usage: npx tsx src/scripts/importPartnerGroups.ts <courseId> <roundNumber> <path-to-csv>",
    );
    process.exit(1);
  }
  const roundNumber = Number(roundNumberRaw);
  if (!Number.isInteger(roundNumber) || roundNumber < 1 || roundNumber > PARTNER_MAX_ROUNDS) {
    throw new Error(`roundNumber must be an integer between 1 and ${PARTNER_MAX_ROUNDS}.`);
  }

  const rows = parseCsv(readFileSync(filePath, "utf-8"));
  if (rows.length === 0) {
    throw new Error(`No usable rows found in ${filePath}.`);
  }

  const prismaClient = new PrismaClient();
  await prismaClient.course
    .findUniqueOrThrow({ where: { id: courseId }, select: { id: true } })
    .catch(() => {
      throw new Error(`No course with id '${courseId}' exists.`);
    });

  const students = await prismaClient.users.findMany({
    where: { courseId, role: Role.STUDENT, enabled: true },
    select: { netId: true, labSection: true },
  });
  const studentByNetId = new Map(students.map((s) => [s.netId, s]));

  const netIdsByGroupId = new Map<string, string[]>();
  for (const row of rows) {
    const list = netIdsByGroupId.get(row.groupid) ?? [];
    list.push(row.netid);
    netIdsByGroupId.set(row.groupid, list);
  }

  const groupsBySection = new Map<string, string[][]>();
  const errors: string[] = [];
  for (const [groupId, netIds] of netIdsByGroupId) {
    const sections = new Set<string>();
    let allValid = true;
    for (const netId of netIds) {
      const student = studentByNetId.get(netId);
      if (!student) {
        errors.push(`Group ${groupId}: '${netId}' is not an enabled student in this course.`);
        allValid = false;
        continue;
      }
      if (!student.labSection) {
        errors.push(`Group ${groupId}: '${netId}' has no lab section assigned.`);
        allValid = false;
        continue;
      }
      sections.add(student.labSection);
    }
    if (sections.size > 1) {
      errors.push(
        `Group ${groupId}: members span multiple lab sections (${[...sections].join(", ")}).`,
      );
      allValid = false;
    }
    if (!allValid) continue;
    const [labSection] = sections;
    const list = groupsBySection.get(labSection) ?? [];
    list.push(netIds);
    groupsBySection.set(labSection, list);
  }

  if (errors.length > 0) {
    console.error("Errors found - fix these rows and re-run before any data is written:");
    for (const message of errors) console.error(`  ${message}`);
    process.exit(1);
  }

  await prismaClient.$transaction(async (tx) => {
    for (const [labSection, groupsOfNetIds] of groupsBySection) {
      await archiveAndCreateGroups({
        tx,
        courseId,
        labSection,
        roundNumber,
        groupsOfNetIds,
        actorNetId: PARTNER_IMPORT_SYSTEM_ACTOR,
      });
    }
  });

  console.log(`Imported partner groups for course '${courseId}', round ${roundNumber}:`);
  for (const [labSection, groupsOfNetIds] of groupsBySection) {
    console.log(`  Section ${labSection}: ${groupsOfNetIds.length} group(s).`);
  }

  await prismaClient.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
