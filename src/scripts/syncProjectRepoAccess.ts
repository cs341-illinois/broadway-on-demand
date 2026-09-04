// Adds each assigned student as a direct collaborator on their project repo
// via the GitHub REST API, using the githubUsername mined by mineGithubUsernames.ts.
// Idempotent: adding an existing collaborator is a no-op. Sets githubAccessConfirmed
// on success.
//
// Usage: npx tsx src/scripts/syncProjectRepoAccess.ts <courseId> [--projectKey <key>]
import dotenv from "dotenv";
dotenv.config();
if (!process.env.DATABASE_URL) {
  throw new Error("Failed to find DATABASE_URL environment variable.");
}

import pino from "pino";
import { PrismaClient } from "../generated/prisma/client.js";
import { retryAsync } from "../functions/utils.js";

const logger = pino.pino({ level: process.env.LOG_LEVEL || "info" });
const prisma = new PrismaClient();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let lastRequestMs = 0;
const MIN_INTERVAL_MS = 500;

async function throttle() {
  const elapsed = Date.now() - lastRequestMs;
  const wait = MIN_INTERVAL_MS - elapsed;
  if (wait > 0) await sleep(wait);
  lastRequestMs = Date.now();
}

async function checkCollaborator(
  org: string,
  repo: string,
  username: string,
  token: string,
): Promise<boolean> {
  await throttle();
  const res = await fetch(
    `https://api.github.com/repos/${org}/${repo}/collaborators/${username}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } },
  );
  if (res.status === 204) return true;
  if (res.status === 404) return false;
  throw new Error(`Check collaborator failed: ${res.status} for ${org}/${repo}/${username}`);
}

async function addCollaborator(
  org: string,
  repo: string,
  username: string,
  token: string,
): Promise<void> {
  await throttle();
  const res = await fetch(
    `https://api.github.com/repos/${org}/${repo}/collaborators/${username}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ permission: "push" }),
    },
  );
  if (res.status !== 201 && res.status !== 204) {
    const body = await res.text().catch(() => "");
    throw new Error(`Add collaborator failed: ${res.status} for ${org}/${repo}/${username}: ${body.slice(0, 200)}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const courseId = args.find((a) => !a.startsWith("-"));
  if (!courseId) {
    console.error("Usage: npx tsx src/scripts/syncProjectRepoAccess.ts <courseId> [--projectKey <key>]");
    process.exit(1);
  }
  let projectKey: string | undefined;
  const pkIdx = args.indexOf("--projectKey");
  if (pkIdx !== -1 && args[pkIdx + 1]) projectKey = args[pkIdx + 1];

  const course = await prisma.course.findUniqueOrThrow({
    where: { id: courseId },
    select: { githubOrg: true, githubToken: true },
  });

  const assignments = await prisma.projectRepoAssignment.findMany({
    where: { courseId, releasedAt: null, ...(projectKey ? { projectKey } : {}) },
    select: { id: true, netId: true, repoName: true, projectKey: true, githubAccessConfirmed: true },
  });

  if (assignments.length === 0) {
    console.log("No active project repo assignments found.");
    return;
  }

  const netIds = [...new Set(assignments.map((a) => a.netId))];
  const mappings = await prisma.githubUsernameMapping.findMany({
    where: { courseId, netId: { in: netIds } },
    select: { netId: true, githubUsername: true },
  });
  const usernameByNetId = new Map(mappings.map((m) => [m.netId, m.githubUsername]));

  let confirmed = 0;
  let alreadyConfirmed = 0;
  let added = 0;
  let noMapping = 0;
  let failed = 0;

  for (const a of assignments) {
    const username = usernameByNetId.get(a.netId);
    if (!username) {
      logger.warn({ netId: a.netId, repoName: a.repoName }, "No GitHub username mapping; skipping");
      noMapping++;
      continue;
    }

    if (a.githubAccessConfirmed) {
      alreadyConfirmed++;
      continue;
    }

    try {
      const isCollab = await retryAsync(
        checkCollaborator,
        { retries: 3, delayMs: 1000 },
        course.githubOrg,
        a.repoName,
        username,
        course.githubToken,
      );

      if (!isCollab) {
        await retryAsync(
          addCollaborator,
          { retries: 3, delayMs: 2000 },
          course.githubOrg,
          a.repoName,
          username,
          course.githubToken,
        );
        added++;
        logger.info({ netId: a.netId, username, repoName: a.repoName }, "Added collaborator");
      } else {
        confirmed++;
      }

      await prisma.projectRepoAssignment.update({
        where: { id: a.id },
        data: { githubAccessConfirmed: true },
      });
    } catch (e: any) {
      logger.error(
        { netId: a.netId, username, repoName: a.repoName, err: e.message },
        "Failed to sync collaborator",
      );
      failed++;
    }
  }

  console.log(`\nGitHub access sync complete for course '${courseId}':`);
  console.log(`  Already confirmed: ${alreadyConfirmed}`);
  console.log(`  Found existing collaborator: ${confirmed}`);
  console.log(`  Newly added: ${added}`);
  console.log(`  No username mapping: ${noMapping}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Total assignments: ${assignments.length}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    prisma.$disconnect();
    process.exit(1);
  });
