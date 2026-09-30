// Syncs each assigned student as a direct collaborator on their project repo
// via the GitHub REST API, using the githubUsername mined by mineGithubUsernames.ts.
// Also removes stale collaborators who no longer have an active assignment,
// preserving the staff team ({githubRepoPrefix}_staff-team).
//
// Maintains a sync-derived tri-state per assignment:
//   githubAccessConfirmed  - verified direct collaborator
//   githubInviteSentAt     - invitation open on GitHub, awaiting acceptance
// A student in neither state (e.g. their invite expired before acceptance) is
// re-invited with a fresh PUT, healing expired invitations on every run.
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
import { getStaffTeamSlug } from "../functions/projectRepos.js";

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

async function addCollaborator(
  org: string,
  repo: string,
  username: string,
  token: string,
): Promise<number> {
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
    throw new Error(
      `Add collaborator failed: ${res.status} for ${org}/${repo}/${username}: ${body.slice(0, 200)}`,
    );
  }
  return res.status;
}

// Lists invitee logins with a currently open invitation on the repo. Expired
// invites vanish from this list, and entries can (rarely) carry expired:true —
// treat those as not open so the re-invite branch fires instead.
async function listInvitations(
  org: string,
  repo: string,
  token: string,
): Promise<string[]> {
  const logins: string[] = [];
  let page = 1;
  while (true) {
    await throttle();
    const res = await fetch(
      `https://api.github.com/repos/${org}/${repo}/invitations?per_page=100&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
        },
      },
    );
    if (res.status !== 200) {
      throw new Error(
        `List invitations failed: ${res.status} for ${org}/${repo}`,
      );
    }
    const invites = (await res.json()) as {
      invitee: { login: string } | null;
      expired: boolean;
    }[];
    for (const inv of invites) {
      if (inv.invitee && !inv.expired) {
        logins.push(inv.invitee.login);
      }
    }
    if (invites.length < 100) break;
    page++;
  }
  return logins;
}

async function listCollaborators(
  org: string,
  repo: string,
  token: string,
): Promise<string[]> {
  const logins: string[] = [];
  let page = 1;
  while (true) {
    await throttle();
    const res = await fetch(
      `https://api.github.com/repos/${org}/${repo}/collaborators?affiliation=direct&per_page=100&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
        },
      },
    );
    if (res.status !== 200) {
      throw new Error(
        `List collaborators failed: ${res.status} for ${org}/${repo}`,
      );
    }
    const collabs = (await res.json()) as { login: string }[];
    for (const c of collabs) {
      logins.push(c.login);
    }
    if (collabs.length < 100) break;
    page++;
  }
  return logins;
}

async function removeCollaborator(
  org: string,
  repo: string,
  username: string,
  token: string,
): Promise<boolean> {
  await throttle();
  const res = await fetch(
    `https://api.github.com/repos/${org}/${repo}/collaborators/${username}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
    },
  );
  return res.status === 204;
}

async function main() {
  const args = process.argv.slice(2);
  const courseId = args.find((a) => !a.startsWith("-"));
  if (!courseId) {
    console.error(
      "Usage: npx tsx src/scripts/syncProjectRepoAccess.ts <courseId> [--projectKey <key>]",
    );
    process.exit(1);
  }
  let projectKey: string | undefined;
  const pkIdx = args.indexOf("--projectKey");
  if (pkIdx !== -1 && args[pkIdx + 1]) projectKey = args[pkIdx + 1];

  const course = await prisma.course.findUniqueOrThrow({
    where: { id: courseId },
    select: {
      githubOrg: true,
      githubToken: true,
      githubRepoPrefix: true,
      staffTeamSlug: true,
    },
  });

  const staffTeam = getStaffTeamSlug(course);
  // Preserve both the configured staff team and the legacy
  // `{prefix}_staff-team` convention - older repos may carry the legacy
  // team's access, and removing team entries via the collaborators API is
  // unreliable. Never sweep either.
  const preservedTeamSlugs = new Set([
    staffTeam,
    `${course.githubRepoPrefix}_staff-team`,
  ]);

  const assignments = await prisma.projectRepoAssignment.findMany({
    where: {
      courseId,
      releasedAt: null,
      ...(projectKey ? { projectKey } : {}),
    },
    select: {
      id: true,
      netId: true,
      repoName: true,
      projectKey: true,
      githubAccessConfirmed: true,
      githubInviteSentAt: true,
    },
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
  const usernameByNetId = new Map(
    mappings.map((m) => [m.netId, m.githubUsername]),
  );

  // Group assignments by repo for per-repo collaborator management
  const assignmentsByRepo = new Map<string, typeof assignments>();
  for (const a of assignments) {
    const list = assignmentsByRepo.get(a.repoName) ?? [];
    list.push(a);
    assignmentsByRepo.set(a.repoName, list);
  }

  let confirmed = 0;
  let added = 0;
  let reinvited = 0;
  let pendingInvites = 0;
  let removed = 0;
  let noMapping = 0;
  let failed = 0;

  for (const [repoName, repoAssignments] of assignmentsByRepo) {
    // Build the set of GitHub usernames that SHOULD have access
    const expectedUsernames = new Set<string>();
    for (const a of repoAssignments) {
      const username = usernameByNetId.get(a.netId);
      if (!username) {
        logger.warn(
          { netId: a.netId, repoName },
          "No GitHub username mapping; skipping",
        );
        noMapping++;
      } else {
        expectedUsernames.add(username);
      }
    }

    try {
      // List current direct collaborators on the repo
      const currentCollaborators = await retryAsync(
        listCollaborators,
        { retries: 3, delayMs: 1000 },
        course.githubOrg,
        repoName,
        course.githubToken,
      );

      // List currently open invitations on the repo. A student absent from
      // both lists has no live access path — the signal that a fresh invite
      // must be sent (e.g. the prior invite expired before acceptance).
      const openInviteLogins = await retryAsync(
        listInvitations,
        { retries: 3, delayMs: 1000 },
        course.githubOrg,
        repoName,
        course.githubToken,
      );

      // Reconcile each assigned student's access state against GitHub.
      // githubAccessConfirmed is derived state meaning "verified direct
      // collaborator"; githubInviteSentAt means "invitation open, awaiting
      // acceptance".
      for (const a of repoAssignments) {
        const username = usernameByNetId.get(a.netId);
        if (!username) continue;

        if (currentCollaborators.includes(username)) {
          confirmed++;
          if (
            a.githubAccessConfirmed !== true ||
            a.githubInviteSentAt !== null
          ) {
            await prisma.projectRepoAssignment.update({
              where: { id: a.id },
              data: {
                githubAccessConfirmed: true,
                githubInviteSentAt: null,
              },
            });
          }
          continue;
        }

        if (openInviteLogins.includes(username)) {
          // Invitation open on GitHub, awaiting acceptance. Don't re-PUT:
          // the 50-invitations/repo/24h cap makes blind refreshes costly.
          pendingInvites++;
          if (
            a.githubAccessConfirmed !== false ||
            a.githubInviteSentAt === null
          ) {
            await prisma.projectRepoAssignment.update({
              where: { id: a.id },
              data: {
                githubAccessConfirmed: false,
                githubInviteSentAt: a.githubInviteSentAt ?? new Date(),
              },
            });
          }
          continue;
        }

        // No access and no open invite: never invited, or the invite
        // expired/was declined before acceptance. PUT sends a fresh
        // invitation (201) or grants directly (204) if access raced into
        // existence.
        const status = await retryAsync(
          addCollaborator,
          { retries: 3, delayMs: 2000 },
          course.githubOrg,
          repoName,
          username,
          course.githubToken,
        );
        if (status === 204) {
          confirmed++;
          await prisma.projectRepoAssignment.update({
            where: { id: a.id },
            data: {
              githubAccessConfirmed: true,
              githubInviteSentAt: null,
            },
          });
          continue;
        }
        if (a.githubAccessConfirmed) {
          reinvited++;
          logger.info(
            { netId: a.netId, username, repoName },
            "Re-invited collaborator (prior invite expired or declined)",
          );
        } else {
          added++;
          logger.info({ netId: a.netId, username, repoName }, "Added collaborator");
        }
        await prisma.projectRepoAssignment.update({
          where: { id: a.id },
          data: {
            githubAccessConfirmed: false,
            githubInviteSentAt: new Date(),
          },
        });
      }

      // Remove collaborators who shouldn't have access (preserve staff team)
      for (const login of currentCollaborators) {
        if (preservedTeamSlugs.has(login)) continue;
        if (expectedUsernames.has(login)) continue;

        const ok = await retryAsync(
          removeCollaborator,
          { retries: 3, delayMs: 2000 },
          course.githubOrg,
          repoName,
          login,
          course.githubToken,
        );
        if (ok) {
          removed++;
          logger.info({ login, repoName }, "Removed stale collaborator");
        } else {
          logger.warn(
            { login, repoName },
            "Failed to remove stale collaborator",
          );
        }
      }
    } catch (e: any) {
      logger.error(
        { repoName, err: e.message },
        "Failed to sync GitHub access for repo",
      );
      failed += repoAssignments.length;
    }
  }

  console.log(`\nGitHub access sync complete for course '${courseId}':`);
  console.log(`  Verified direct collaborator: ${confirmed}`);
  console.log(`  Invite awaiting acceptance: ${pendingInvites}`);
  console.log(`  Newly invited: ${added}`);
  console.log(`  Re-invited (prior invite expired/declined): ${reinvited}`);
  console.log(`  Stale collaborators removed: ${removed}`);
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
