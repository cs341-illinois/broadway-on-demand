// Reconciles published grades that were lowered by extension grading runs.
//
// Background: completeGradingRun used to publish extension-run scores as a
// plain overwrite, so a student's grade could end up below what it was before
// their extension run. Later regrades clamp against the (poisoned) published
// value, so the damage propagated through subsequent automated publishes.
// The DB keeps no history of autograder publishes (staging grades are deleted
// after publish; GradeAuditLog only covers manual project edits), so the
// grades repo commit history - every publish commits
// grade_csvs/<assignmentId>.csv naming its job - is the only surviving record.
//
// The replay repairs extension-caused reductions (jobs referenced by
// Extensions.finalGradingRunId) and their propagation through later automated
// publishes, while honoring manual "Grade Update" / "Grade Upload" commits as
// authoritative resets. It only ever raises grades; it never lowers or
// deletes. PROJECT assignments are skipped: their manual-edit path
// (projectGrades) does not sync to the grades repo, so CSV history is not
// trustworthy there.
//
// Usage:
//   npx tsx src/scripts/reconcileExtensionGradeDrops.ts <courseId> [options]
//
// Options:
//   --assignment <id>   Limit reconciliation to one assignment
//   --apply             Prepare the planned writes (requires --yes to execute)
//   --yes               Execute writes together with --apply; default dry-run
import dotenv from "dotenv";
dotenv.config();
if (!process.env.DATABASE_URL) {
  throw new Error("Failed to find DATABASE_URL environment variable.");
}

import { Octokit } from "@octokit/rest";
import { parse as parseCsv } from "csv-parse/sync";
import { Category, PrismaClient } from "../generated/prisma/client.js";
import { generateGradesCsv } from "../functions/github.js";

const prisma = new PrismaClient();

const JOB_ID_REGEX = /Job ID (\S+)/;
const MANUAL_PREFIXES = [
  "Grade Update for assignment ",
  "Grade Upload for assignment ",
];

type CommitKind = "extension" | "automated" | "manual";

interface CommitSnapshot {
  sha: string;
  date: Date;
  kind: CommitKind;
  jobId: string | null;
  rows: Map<string, { score: number; comments: string }>;
}

interface ReplayResult {
  value: number;
  comments: string;
  poisonedEver: boolean;
  extensionJobs: string[];
}

interface Fix {
  netId: string;
  kind: "update" | "create";
  currentScore: number | null;
  newScore: number;
  comments: string;
  extensionJobs: string[];
}

interface ParsedArgs {
  courseId: string;
  assignmentId?: string;
  apply: boolean;
  yes: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const courseId = args.find((a) => !a.startsWith("-"));
  if (!courseId) {
    console.error(
      "Usage: npx tsx src/scripts/reconcileExtensionGradeDrops.ts <courseId> [--assignment <id>] [--apply] [--yes]",
    );
    process.exit(1);
  }
  let assignmentId: string | undefined;
  const aIdx = args.indexOf("--assignment");
  if (aIdx !== -1 && args[aIdx + 1]) {
    assignmentId = args[aIdx + 1];
  }
  return {
    courseId,
    assignmentId,
    apply: args.includes("--apply"),
    yes: args.includes("--yes"),
  };
}

/**
 * Float-preserving CSV parse. Deliberately does not reuse
 * parseGradesCsvData, which truncates scores with parseInt.
 */
export function parseHistoryCsv(content: string) {
  const parsed = parseCsv(content, {
    columns: true,
    skip_empty_lines: true,
  }) as Record<string, string>[];
  const rows = new Map<string, { score: number; comments: string }>();
  for (const row of parsed) {
    const netId = String(row.netid ?? "").trim();
    if (!netId) continue;
    const score = parseFloat(row.score);
    if (!Number.isFinite(score)) continue;
    rows.set(netId, {
      score,
      comments: row.comments ? String(row.comments) : "",
    });
  }
  return rows;
}

export function classifyCommit(message: string, extensionJobIds: Set<string>) {
  if (MANUAL_PREFIXES.some((p) => message.startsWith(p))) {
    return { kind: "manual" as CommitKind, jobId: null };
  }
  const match = message.match(JOB_ID_REGEX);
  if (match) {
    return {
      kind: extensionJobIds.has(match[1])
        ? ("extension" as CommitKind)
        : ("automated" as CommitKind),
      jobId: match[1],
    };
  }
  return { kind: "automated" as CommitKind, jobId: null };
}

/**
 * Hybrid replay: extension publishes are floored at the value the student had
 * going into them (marking the history as poisoned); while poisoned, later
 * automated publishes are floored too (their clamp logic used the lowered
 * value); manual commits are honored literally and clear the poisoning.
 */
export function replayStudent(
  snapshots: CommitSnapshot[],
  netId: string,
): ReplayResult | null {
  let value: number | undefined;
  let comments = "";
  let poisoned = false;
  let poisonedEver = false;
  const extensionJobs: string[] = [];
  for (const snap of snapshots) {
    const row = snap.rows.get(netId);
    if (snap.kind === "manual") {
      poisoned = false;
      if (row) {
        value = row.score;
        comments = row.comments;
      } else {
        value = undefined;
        comments = "";
      }
      continue;
    }
    if (!row) continue;
    if (snap.kind === "extension") {
      if (snap.jobId) extensionJobs.push(snap.jobId);
      if (value === undefined) {
        value = row.score;
        comments = row.comments;
      } else if (row.score < value) {
        poisoned = true;
        poisonedEver = true;
      } else if (row.score > value) {
        value = row.score;
        comments = row.comments;
      }
    } else {
      if (poisoned) {
        if (row.score > value!) {
          value = row.score;
          comments = row.comments;
        }
      } else {
        value = row.score;
        comments = row.comments;
      }
    }
  }
  if (value === undefined) return null;
  return { value, comments, poisonedEver, extensionJobs };
}

async function main() {
  const args = parseArgs(process.argv);
  const course = await prisma.course.findUnique({
    where: { id: args.courseId },
    select: { githubOrg: true, githubToken: true, gradesRepo: true },
  });
  if (!course?.githubOrg || !course.gradesRepo || !course.githubToken) {
    throw new Error(
      `Course '${args.courseId}' not found or missing grades repo configuration.`,
    );
  }
  const octokit = new Octokit({ auth: course.githubToken });

  const extensions = await prisma.extensions.findMany({
    where: {
      courseId: args.courseId,
      finalGradingRunId: { not: null },
      ...(args.assignmentId ? { assignmentId: args.assignmentId } : {}),
    },
    select: { assignmentId: true, netId: true, finalGradingRunId: true },
  });
  if (extensions.length === 0) {
    console.log("No extension runs with grading jobs found. Nothing to do.");
    return;
  }

  const assignmentIds = [...new Set(extensions.map((e) => e.assignmentId))];
  const assignments = await prisma.assignment.findMany({
    where: { courseId: args.courseId, id: { in: assignmentIds } },
    select: { id: true, category: true },
  });
  const categoryById = new Map(assignments.map((a) => [a.id, a.category]));

  const extensionJobIdsByAssignment = new Map<string, Set<string>>();
  const extensionNetIdsByAssignment = new Map<string, Set<string>>();
  for (const e of extensions) {
    if (!e.finalGradingRunId) continue;
    if (!extensionJobIdsByAssignment.has(e.assignmentId)) {
      extensionJobIdsByAssignment.set(e.assignmentId, new Set());
    }
    extensionJobIdsByAssignment.get(e.assignmentId)!.add(e.finalGradingRunId);
    if (!extensionNetIdsByAssignment.has(e.assignmentId)) {
      extensionNetIdsByAssignment.set(e.assignmentId, new Set());
    }
    extensionNetIdsByAssignment.get(e.assignmentId)!.add(e.netId);
  }

  const publishedRows = await prisma.publishedGrades.findMany({
    where: { courseId: args.courseId, assignmentId: { in: assignmentIds } },
    select: {
      assignmentId: true,
      netId: true,
      score: true,
      comments: true,
    },
  });
  const currentByAssignment = new Map<
    string,
    Map<string, { score: number; comments: string | null }>
  >();
  for (const row of publishedRows) {
    if (!currentByAssignment.has(row.assignmentId)) {
      currentByAssignment.set(row.assignmentId, new Map());
    }
    currentByAssignment.get(row.assignmentId)!.set(row.netId, {
      score: row.score,
      comments: row.comments,
    });
  }

  const fixesByAssignment = new Map<string, Fix[]>();

  for (const assignmentId of assignmentIds) {
    const category = categoryById.get(assignmentId);
    if (category !== Category.LAB && category !== Category.MP) {
      console.log(
        `\n${assignmentId}: skipped (category ${category ?? "unknown"} - manual edits do not sync to the grades repo, CSV history untrustworthy).`,
      );
      continue;
    }
    const csvPath = `grade_csvs/${assignmentId}.csv`;
    let commits;
    try {
      commits = await octokit.paginate(octokit.repos.listCommits, {
        owner: course.githubOrg,
        repo: course.gradesRepo,
        path: csvPath,
        per_page: 100,
      });
    } catch (e: any) {
      console.log(
        `\n${assignmentId}: skipped (could not list commits for ${csvPath}: ${e.message}).`,
      );
      continue;
    }
    if (commits.length === 0) {
      console.log(`\n${assignmentId}: skipped (no commits for ${csvPath}).`);
      continue;
    }

    const snapshots: CommitSnapshot[] = [];
    for (const commit of commits.reverse()) {
      try {
        const { data } = await octokit.repos.getContent({
          owner: course.githubOrg,
          repo: course.gradesRepo,
          path: csvPath,
          ref: commit.sha,
        });
        if (Array.isArray(data) || data.type !== "file") continue;
        const content = Buffer.from(data.content, "base64").toString();
        const { kind, jobId } = classifyCommit(
          commit.commit.message,
          extensionJobIdsByAssignment.get(assignmentId) ?? new Set(),
        );
        snapshots.push({
          sha: commit.sha,
          date: new Date(
            commit.commit.committer?.date ??
              commit.commit.author?.date ??
              0,
          ),
          kind,
          jobId,
          rows: parseHistoryCsv(content),
        });
      } catch (e: any) {
        console.log(
          `${assignmentId}: warning - could not fetch ${csvPath} at ${commit.sha.slice(0, 7)}: ${e.message}`,
        );
      }
    }
    if (snapshots.length === 0) {
      console.log(`\n${assignmentId}: skipped (no readable snapshots).`);
      continue;
    }

    const currentRows = currentByAssignment.get(assignmentId) ?? new Map();
    const fixes: Fix[] = [];
    for (const netId of extensionNetIdsByAssignment.get(assignmentId)!) {
      const replay = replayStudent(snapshots, netId);
      // Only touch histories where an extension run actually lowered the
      // grade - everything else replays to the current value anyway.
      if (!replay || !replay.poisonedEver) continue;
      const current = currentRows.get(netId);
      if (current && current.score >= replay.value) continue;
      fixes.push({
        netId,
        kind: current ? "update" : "create",
        currentScore: current?.score ?? null,
        newScore: replay.value,
        comments: replay.comments,
        extensionJobs: replay.extensionJobs,
      });
    }
    if (fixes.length > 0) {
      fixesByAssignment.set(assignmentId, fixes);
    }
  }

  // Report.
  console.log("\n================ Reconciliation report ================");
  let totalUpdates = 0;
  let totalCreates = 0;
  for (const [assignmentId, fixes] of fixesByAssignment) {
    console.log(`\n${assignmentId}:`);
    for (const fix of fixes) {
      const action =
        fix.kind === "update"
          ? `${fix.currentScore} -> ${fix.newScore}`
          : `[WOULD CREATE] ${fix.newScore}`;
      if (fix.kind === "update") totalUpdates += 1;
      else totalCreates += 1;
      console.log(
        `  ${fix.kind === "create" ? "[WOULD CREATE]" : "[WOULD UPDATE]"} ${fix.netId}: ${action} (extension jobs: ${fix.extensionJobs.join(", ")})`,
      );
    }
  }
  if (fixesByAssignment.size === 0) {
    console.log("\nNo extension-caused grade drops found. Nothing to do.");
    return;
  }
  console.log(
    `\nSummary: ${totalUpdates} update(s), ${totalCreates} create(s) across ${fixesByAssignment.size} assignment(s).`,
  );

  if (!args.apply) {
    console.log("\nDry run - nothing written. Re-run with --apply to proceed.");
    return;
  }
  if (!args.yes) {
    console.log(
      "\n--apply given but --yes missing. Re-run with --apply --yes to write.",
    );
    return;
  }

  // Write DB changes + audit log, then push corrected CSVs.
  for (const [assignmentId, fixes] of fixesByAssignment) {
    for (const fix of fixes) {
      if (fix.kind === "update") {
        await prisma.publishedGrades.update({
          where: {
            courseId_assignmentId_netId: {
              courseId: args.courseId,
              assignmentId,
              netId: fix.netId,
            },
          },
          data: { score: fix.newScore, comments: fix.comments },
        });
      } else {
        await prisma.publishedGrades.create({
          data: {
            courseId: args.courseId,
            assignmentId,
            netId: fix.netId,
            score: fix.newScore,
            comments: fix.comments,
          },
        });
      }
    }
    await prisma.gradeAuditLog.createMany({
      data: fixes.map((fix) => ({
        courseId: args.courseId,
        assignmentId,
        netId: fix.netId,
        oldScore: fix.currentScore,
        newScore: fix.newScore,
        changedBy: "reconcileExtensionGradeDrops",
        justification: `Restored grade lowered by extension grading run(s): ${fix.extensionJobs.join(", ")}. Replayed from grades repo history.`,
      })),
    });
    await commitCorrectedCsv({
      octokit,
      owner: course.githubOrg,
      repo: course.gradesRepo,
      assignmentId,
      fixes,
    });
    console.log(`${assignmentId}: wrote ${fixes.length} fix(es) + CSV commit.`);
  }
  console.log("\nDone.");
}

async function commitCorrectedCsv({
  octokit,
  owner,
  repo,
  assignmentId,
  fixes,
}: {
  octokit: Octokit;
  owner: string;
  repo: string;
  assignmentId: string;
  fixes: Fix[];
}) {
  const path = `grade_csvs/${assignmentId}.csv`;
  const { data } = await octokit.repos.getContent({ owner, repo, path });
  if (Array.isArray(data) || data.type !== "file") {
    throw new Error(`Expected ${path} to be a file in ${owner}/${repo}.`);
  }
  const rows = parseHistoryCsv(Buffer.from(data.content, "base64").toString());
  for (const fix of fixes) {
    rows.set(fix.netId, { score: fix.newScore, comments: fix.comments });
  }
  const entries = Array.from(rows.entries()).map(([netId, row]) => ({
    netId,
    score: row.score,
    comments: row.comments,
  }));
  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path,
    branch: "main",
    sha: data.sha,
    message: `Reconcile extension grade drops for ${assignmentId}\n\nRestored grades lowered by extension grading runs.\nJob IDs: ${[
      ...new Set(fixes.flatMap((f) => f.extensionJobs)),
    ].join(", ")}`,
    content: Buffer.from(generateGradesCsv(entries)).toString("base64"),
  });
}

// Run main only when this module is the process entry point, so the pure
// helpers above can be imported (e.g. by verification harnesses) without
// triggering a database connection.
if (
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "__none__")
) {
  main()
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
