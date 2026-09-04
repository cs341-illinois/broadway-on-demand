import {
  AssignmentQuota,
  AssignmentVisibility,
  Category,
  PrismaClient,
} from "../generated/prisma/client.js";
import { PrairieLearnApiError } from "../errors/index.js";
import { FastifyBaseLogger } from "fastify";

// Confirmed against a live GET .../gradebook response from a real course
// instance (2026-08-30). score_perc can exceed 100 (bonus points on an
// assessment) and can be null (student hasn't started/been graded yet).
interface PrairieLearnGradebookAssessmentScore {
  assessment_id: string;
  assessment_label: string;
  score_perc: number | null;
}

interface PrairieLearnGradebookRow {
  user_uid: string;
  user_role: string;
  assessments: PrairieLearnGradebookAssessmentScore[];
}

export async function fetchPrairieLearnGradebook({
  baseUrl,
  apiToken,
  courseInstanceId,
  logger,
}: {
  baseUrl: string;
  apiToken: string;
  courseInstanceId: string;
  logger: FastifyBaseLogger;
}): Promise<PrairieLearnGradebookRow[]> {
  const url = `${baseUrl.replace(/\/$/, "")}/pl/api/v1/course_instances/${courseInstanceId}/gradebook`;
  const response = await fetch(url, {
    headers: { "Private-Token": apiToken },
  }).catch((e) => {
    logger.error(e);
    throw new PrairieLearnApiError({
      message: "Could not reach the PrairieLearn API.",
    });
  });
  if (!response.ok) {
    logger.error(
      `PrairieLearn gradebook fetch failed: ${response.status} ${response.statusText}`,
    );
    throw new PrairieLearnApiError({
      message: `PrairieLearn API returned ${response.status}.`,
    });
  }
  return (await response.json()) as PrairieLearnGradebookRow[];
}

export interface PrairieLearnSyncSummary {
  assignmentsCreated: number;
  assignmentsUpdated: number;
  gradesUpserted: number;
  skippedNetIds: string[];
}

export async function syncPrairieLearnGrades({
  courseId,
  prismaClient,
  logger,
}: {
  courseId: string;
  prismaClient: PrismaClient;
  logger: FastifyBaseLogger;
}): Promise<PrairieLearnSyncSummary> {
  const course = await prismaClient.course.findUniqueOrThrow({
    where: { id: courseId },
    select: {
      prairieLearnBaseUrl: true,
      prairieLearnCourseInstanceId: true,
      prairieLearnApiToken: true,
    },
  });
  const { prairieLearnBaseUrl, prairieLearnCourseInstanceId, prairieLearnApiToken } =
    course;
  if (!prairieLearnBaseUrl || !prairieLearnCourseInstanceId || !prairieLearnApiToken) {
    throw new PrairieLearnApiError({
      message:
        "PrairieLearn is not configured for this course. Run applyGradingConfig.ts with a prairieLearn block first.",
    });
  }

  const gradebook = await fetchPrairieLearnGradebook({
    baseUrl: prairieLearnBaseUrl,
    apiToken: prairieLearnApiToken,
    courseInstanceId: prairieLearnCourseInstanceId,
    logger,
  });

  const roster = await prismaClient.users.findMany({
    where: { courseId, enabled: true },
    select: { netId: true },
  });
  const rosterNetIds = new Set(roster.map((u) => u.netId));

  const assessments = new Map<string, string>(); // assessment_id -> assessment_label
  for (const row of gradebook) {
    for (const s of row.assessments) {
      if (!assessments.has(s.assessment_id)) {
        assessments.set(s.assessment_id, s.assessment_label);
      }
    }
  }

  const summary: PrairieLearnSyncSummary = {
    assignmentsCreated: 0,
    assignmentsUpdated: 0,
    gradesUpserted: 0,
    skippedNetIds: [],
  };

  await prismaClient.$transaction(async (tx) => {
    // Assignment.id must fit the same identifier role as any other
    // assignment id used throughout the app, so scope it under a stable
    // "pl-" prefix rather than reusing PrairieLearn's raw internal id.
    const assessmentIdToAssignmentId = new Map<string, string>();
    for (const [assessmentId, assessmentName] of assessments) {
      const assignmentId = `pl-${assessmentId}`;
      const existing = await tx.assignment.findUnique({
        where: { courseId_id: { courseId, id: assignmentId } },
      });
      if (existing) {
        summary.assignmentsUpdated += 1;
      } else {
        summary.assignmentsCreated += 1;
      }
      // On create only: weight stays at the schema default (0) until an
      // admin assigns a real weight via applyGradingConfig.ts — never
      // overwritten by a resync.
      await tx.assignment.upsert({
        where: { courseId_id: { courseId, id: assignmentId } },
        update: { name: assessmentName },
        create: {
          courseId,
          id: assignmentId,
          name: assessmentName,
          category: Category.PRAIRIELEARN,
          visibility: AssignmentVisibility.DEFAULT,
          quotaPeriod: AssignmentQuota.TOTAL,
          quotaAmount: 0,
          studentExtendable: false,
          openAt: new Date(),
          prairieLearnAssessmentId: assessmentId,
        },
      });
      assessmentIdToAssignmentId.set(assessmentId, assignmentId);
    }

    for (const row of gradebook) {
      // The gradebook includes Staff/Instructor rows alongside Students;
      // those aren't graded coursework and shouldn't produce PublishedGrades
      // even if a TA's netId happens to also exist in the roster.
      if (row.user_role !== "Student") continue;
      const netId = row.user_uid.replace("@illinois.edu", "");
      if (!rosterNetIds.has(netId)) {
        summary.skippedNetIds.push(netId);
        continue;
      }
      for (const s of row.assessments) {
        if (s.score_perc === null) continue;
        const assignmentId = assessmentIdToAssignmentId.get(s.assessment_id)!;
        await tx.publishedGrades.upsert({
          where: {
            courseId_assignmentId_netId: { courseId, assignmentId, netId },
          },
          update: { score: s.score_perc },
          create: {
            courseId,
            assignmentId,
            netId,
            score: s.score_perc,
            comments: "Synced from PrairieLearn.",
          },
        });
        summary.gradesUpserted += 1;
      }
    }

    // Deliberately does NOT call updateStudentGradesToGithub: that helper is
    // designed for one call per assignment per full batch (GitHub existence
    // checks + a distributed lock per assignment) and pushing every PL
    // resync as a grades-repo commit would be noisy for data that's already
    // versioned in PrairieLearn itself.
    await tx.course.update({
      where: { id: courseId },
      data: { prairieLearnLastSyncedAt: new Date() },
    });
  });

  return summary;
}
