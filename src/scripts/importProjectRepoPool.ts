// Generates `{githubRepoPrefix}_.{repoProjectName}_.team-{NN}` names and imports them into ProjectRepoPool
// for a (courseId, projectKey). Append-only; rejects names claimed by another projectKey; sortOrder from max+1.
// Usage: npx tsx src/scripts/importProjectRepoPool.ts <courseId> <projectKey> <repoProjectName> <count>
import dotenv from "dotenv";
dotenv.config();
if (!process.env.DATABASE_URL) {
  throw new Error(
    "Failed to find DATABASE_URL environment variable to connect to database!",
  );
}

import { PrismaClient } from "../generated/prisma/client.js";

function pad3(n: number): string {
  return n.toString().padStart(3, "0");
}

async function main() {
  const [courseId, projectKey, repoProjectName, countRaw] = process.argv.slice(2);
  if (!courseId || !projectKey || !repoProjectName || !countRaw) {
    console.error(
      "Usage: npx tsx src/scripts/importProjectRepoPool.ts <courseId> <projectKey> <repoProjectName> <count>",
    );
    console.error(
      "Example: npx tsx src/scripts/importProjectRepoPool.ts cs341-fa26 project1 project-1 200",
    );
    process.exit(1);
  }

  const count = parseInt(countRaw, 10);
  if (!Number.isFinite(count) || count < 1) {
    throw new Error("count must be a positive integer.");
  }

  const prismaClient = new PrismaClient();
  const course = await prismaClient.course
    .findUniqueOrThrow({
      where: { id: courseId },
      select: { githubRepoPrefix: true },
    })
    .catch(() => {
      throw new Error(`No course with id '${courseId}' exists.`);
    });

  const prefix = course.githubRepoPrefix;
  const repoNames: string[] = [];
  for (let i = 1; i <= count; i++) {
    repoNames.push(`${prefix}_.${repoProjectName}_.team-${pad3(i)}`);
  }

  await prismaClient.$transaction(async (tx) => {
    const overlapping = await tx.projectRepoPool.findMany({
      where: { courseId, repoName: { in: repoNames }, projectKey: { not: projectKey } },
      select: { repoName: true, projectKey: true },
    });
    if (overlapping.length > 0) {
      const lines = overlapping.map(
        (o) => `  ${o.repoName} (existing projectKey: ${o.projectKey})`,
      );
      throw new Error(
        `Aborting: the following repoNames already exist under a different projectKey in this course:\n${lines.join("\n")}`,
      );
    }

    const existing = await tx.projectRepoPool.findMany({
      where: { courseId, projectKey, repoName: { in: repoNames } },
      select: { repoName: true },
    });
    const existingSet = new Set(existing.map((e) => e.repoName));
    for (const name of repoNames) {
      if (existingSet.has(name)) {
        console.warn(
          `WARNING: '${name}' already exists in pool for projectKey '${projectKey}', skipping.`,
        );
      }
    }
    const toInsert = repoNames.filter((n) => !existingSet.has(n));
    if (toInsert.length === 0) {
      console.log("Nothing to insert (all repoNames already exist).");
      return;
    }

    const maxRow = await tx.projectRepoPool.aggregate({
      where: { courseId, projectKey },
      _max: { sortOrder: true },
    });
    let sortOrder = (maxRow._max.sortOrder ?? -1) + 1;
    for (const repoName of toInsert) {
      await tx.projectRepoPool.create({
        data: { courseId, projectKey, repoName, sortOrder },
      });
      sortOrder += 1;
    }

    console.log(
      `Imported ${toInsert.length} repo(s) into pool for course '${courseId}', projectKey '${projectKey}':`,
    );
    console.log(`  First: ${toInsert[0]}`);
    console.log(`  Last:  ${toInsert[toInsert.length - 1]}`);
  });

  await prismaClient.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
