// Applies a grading.config.yaml file (assignment weights, category
// drop-lowest rules, PrairieLearn integration settings) to the database.
// This is the *only* way that configuration is ever written — there is no
// admin UI or API route for it, matching how src/scripts/createCourse.ts is
// the only way a Course row is ever created.
//
// Usage: npx tsx src/scripts/applyGradingConfig.ts <path-to-yaml>
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import dotenv from "dotenv";
dotenv.config();
if (!process.env.DATABASE_URL) {
  throw new Error(
    "Failed to find DATABASE_URL environment variable to connect to database!",
  );
}

import { PrismaClient, Category } from "../generated/prisma/client.js";
import { gradingConfigYamlSchema } from "../types/gradebook.js";

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, varName) => {
    const resolved = process.env[varName];
    if (!resolved) {
      throw new Error(
        `grading.config.yaml references \${${varName}}, but that environment variable is not set.`,
      );
    }
    return resolved;
  });
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: npx tsx src/scripts/applyGradingConfig.ts <path-to-yaml>");
    process.exit(1);
  }

  const raw = parse(readFileSync(filePath, "utf-8"));
  const config = gradingConfigYamlSchema.parse(raw);
  const { courseId } = config;

  const prismaClient = new PrismaClient();

  const unknownAssignmentIds: string[] = [];
  let weightsApplied = 0;
  let categoriesConfigured = 0;

  await prismaClient.$transaction(async (tx) => {
    await tx.course.findUniqueOrThrow({ where: { id: courseId } }).catch(() => {
      throw new Error(`No course with id '${courseId}' exists.`);
    });

    if (config.prairieLearn) {
      await tx.course.update({
        where: { id: courseId },
        data: {
          prairieLearnBaseUrl: config.prairieLearn.baseUrl,
          prairieLearnCourseInstanceId: config.prairieLearn.courseInstanceId,
          prairieLearnApiToken: resolveEnvVars(config.prairieLearn.apiToken),
        },
      });
    }

    for (const [category, { dropLowest }] of Object.entries(config.categories ?? {})) {
      await tx.gradingCategoryConfig.upsert({
        where: {
          courseId_category: { courseId, category: category as Category },
        },
        update: { dropLowest },
        create: { courseId, category: category as Category, dropLowest },
      });
      categoriesConfigured += 1;
    }

    for (const [assignmentId, weight] of Object.entries(config.assignmentWeights ?? {})) {
      const result = await tx.assignment.updateMany({
        where: { courseId, id: assignmentId },
        data: { weight },
      });
      if (result.count === 0) {
        unknownAssignmentIds.push(assignmentId);
      } else {
        weightsApplied += 1;
      }
    }
  });

  if (unknownAssignmentIds.length > 0) {
    console.warn(
      `WARNING: the following assignment ids in assignmentWeights do not exist for course '${courseId}' and were skipped:\n  ${unknownAssignmentIds.join("\n  ")}`,
    );
  }

  const totalWeight = await prismaClient.assignment.aggregate({
    where: { courseId },
    _sum: { weight: true },
  });

  console.log(`Applied grading config for course '${courseId}':`);
  console.log(`  Categories configured: ${categoriesConfigured}`);
  console.log(`  Weights applied: ${weightsApplied}`);
  console.log(`  Unknown assignment ids skipped: ${unknownAssignmentIds.length}`);
  console.log(
    `  Total configured weight across all assignments: ${totalWeight._sum.weight ?? 0} (should sum to 100 across the assignments that make up the final grade)`,
  );

  await prismaClient.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
