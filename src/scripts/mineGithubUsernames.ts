// Mines each enabled student's GitHub username from their course repo's direct collaborators
// via GitHub's GraphQL API and upserts into GithubUsernameMapping (idempotent, throttled <=1/sec).
// Usage: npx tsx src/scripts/mineGithubUsernames.ts <courseId> [--only-missing] [--sample N]
import dotenv from "dotenv";
dotenv.config();
if (!process.env.DATABASE_URL) {
  throw new Error(
    "Failed to find DATABASE_URL environment variable to connect to database!",
  );
}

import pino from "pino";
import { PrismaClient, Role } from "../generated/prisma/client.js";
import { retryAsync } from "../functions/utils.js";

const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";
const REPO_QUERY = `
  query GetRepoMembers($owningOrg: String!, $repoName: String!, $after: String, $first: Int) {
    repository(owner: $owningOrg, name: $repoName) {
      collaborators(affiliation: DIRECT, after: $after, first: $first) {
        nodes { login name }
        pageInfo { endCursor hasNextPage }
      }
    }
  }
`;

type Collaborator = { login: string; name: string | null };

type CollabResult =
  | { kind: "ok"; collaborators: Collaborator[] }
  | { kind: "notFound" }
  | { kind: "error"; message: string };

type GraphQLResponse = {
  data?: {
    repository?: {
      collaborators?: {
        nodes: Collaborator[];
        pageInfo: { endCursor: string; hasNextPage: boolean };
      };
    };
  };
  errors?: { type?: string; message?: string }[];
};

class GithubApiError extends Error {
  retryAfterMs?: number;
  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = "GithubApiError";
    this.retryAfterMs = retryAfterMs;
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

let lastRequestMs = 0;
const MIN_INTERVAL_MS = 1000;

async function throttle(): Promise<void> {
  const elapsed = Date.now() - lastRequestMs;
  const jitter = Math.floor(Math.random() * 500);
  const wait = MIN_INTERVAL_MS + jitter - elapsed;
  if (wait > 0) await sleep(wait);
  lastRequestMs = Date.now();
}

function rateLimitWaitMs(res: Response): number {
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter) {
    const sec = parseInt(retryAfter, 10);
    if (!Number.isNaN(sec)) return sec * 1000;
  }
  const remaining = res.headers.get("x-ratelimit-remaining");
  const reset = res.headers.get("x-ratelimit-reset");
  if (remaining && parseInt(remaining, 10) <= 1 && reset) {
    const resetSec = parseInt(reset, 10);
    if (!Number.isNaN(resetSec)) {
      return Math.max(0, resetSec * 1000 - Date.now());
    }
  }
  return 0;
}

let scopeHeadersLogged = false;

function logScopeHeaders(res: Response): void {
  const oauthScopes = res.headers.get("x-oauth-scopes");
  const acceptedPerms = res.headers.get("x-accepted-github-permissions");
  const remaining = res.headers.get("x-ratelimit-remaining");
  const limit = res.headers.get("x-ratelimit-limit");
  console.log("\n=== First GitHub API call (token scope check) ===");
  console.log(`  x-oauth-scopes (classic tokens): ${oauthScopes ?? "(none)"}`);
  console.log(
    `  x-accepted-github-permissions (fine-grained): ${acceptedPerms ?? "(none)"}`,
  );
  console.log(`  x-ratelimit-remaining: ${remaining ?? "?"} / ${limit ?? "?"}`);
  console.log(
    "  Verify the token has Administration: read access to list collaborators.\n",
  );
}

async function fetchDirectCollaborators(
  org: string,
  repo: string,
  token: string,
  logger: pino.Logger,
): Promise<CollabResult> {
  const collaborators: Collaborator[] = [];
  let after: string | null = null;
  let pages = 0;
  while (true) {
    if (++pages > 20) {
      throw new GithubApiError(`Too many pagination pages for ${org}/${repo}`);
    }
    await throttle();
    const res = await fetch(GITHUB_GRAPHQL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: REPO_QUERY,
        variables: { owningOrg: org, repoName: repo, first: 100, after },
      }),
    });
    if (!scopeHeadersLogged) {
      scopeHeadersLogged = true;
      logScopeHeaders(res);
    }
    const wait = rateLimitWaitMs(res);
    if (!res.ok) {
      if (res.status === 429 || res.status >= 500) {
        throw new GithubApiError(
          `GitHub API ${res.status} for ${org}/${repo}`,
          wait || undefined,
        );
      }
      if (res.status === 403 && wait > 0) {
        throw new GithubApiError(
          `GitHub API 403 rate-limited for ${org}/${repo}`,
          wait,
        );
      }
      const bodyText = await res.text().catch(() => "");
      return {
        kind: "error",
        message: `GitHub API ${res.status} ${res.statusText} for ${org}/${repo}: ${bodyText.slice(0, 200)}`,
      };
    }
    if (wait > 0) {
      logger.warn({ org, repo, waitMs: wait }, "Rate limit low; sleeping");
      await sleep(wait);
    }
    const body = (await res.json()) as GraphQLResponse;
    if (body.errors?.length) {
      if (body.errors.some((e) => e.type === "NOT_FOUND")) {
        return { kind: "notFound" };
      }
      if (body.errors.some((e) => e.type === "FORBIDDEN")) {
        return {
          kind: "error",
          message: `Forbidden accessing ${org}/${repo}: ${JSON.stringify(body.errors)}`,
        };
      }
      throw new GithubApiError(
        `GraphQL errors for ${org}/${repo}: ${JSON.stringify(body.errors)}`,
      );
    }
    const collab = body.data?.repository?.collaborators;
    if (!collab) return { kind: "notFound" };
    collaborators.push(...collab.nodes);
    if (!collab.pageInfo.hasNextPage) break;
    after = collab.pageInfo.endCursor;
  }
  return { kind: "ok", collaborators };
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  let courseId: string | undefined;
  let onlyMissing = false;
  let sampleSize = 30;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--only-missing") {
      onlyMissing = true;
    } else if (a === "--sample") {
      const parsed = parseInt(args[++i], 10);
      sampleSize = Number.isFinite(parsed) && parsed >= 0 ? parsed : 30;
    } else if (a.startsWith("--sample=")) {
      const parsed = parseInt(a.slice("--sample=".length), 10);
      sampleSize = Number.isFinite(parsed) && parsed >= 0 ? parsed : 30;
    } else if (!a.startsWith("-") && !courseId) {
      courseId = a;
    }
  }
  if (!courseId) {
    console.error(
      "Usage: npx tsx src/scripts/mineGithubUsernames.ts <courseId> [--only-missing] [--sample N]",
    );
    process.exit(1);
  }

  const prismaClient = new PrismaClient();
  const logger = pino.pino({ level: process.env.LOG_LEVEL || "info" });

  try {
    const course = await prismaClient.course
      .findUniqueOrThrow({
        where: { id: courseId },
        select: {
          githubOrg: true,
          githubRepoPrefix: true,
          githubToken: true,
        },
      })
      .catch(() => {
        throw new Error(`No course with id '${courseId}' exists.`);
      });
    const { githubOrg, githubRepoPrefix, githubToken } = course;

    const students = await prismaClient.users.findMany({
      where: { courseId, role: Role.STUDENT, enabled: true },
      select: { netId: true },
      orderBy: { netId: "asc" },
    });
    const totalEnabled = students.length;

    const existingMappings = await prismaClient.githubUsernameMapping.findMany({
      where: { courseId },
      select: { netId: true, githubUsername: true, githubName: true },
    });
    const existingByNetId = new Map(
      existingMappings.map((m) => [
        m.netId,
        { githubUsername: m.githubUsername, githubName: m.githubName },
      ]),
    );

    const targets: { netId: string; repoName: string }[] = [];
    let alreadyHadMapping = 0;
    for (const s of students) {
      if (onlyMissing && existingByNetId.has(s.netId)) {
        alreadyHadMapping++;
        continue;
      }
      targets.push({
        netId: s.netId,
        repoName: `${githubRepoPrefix}_${s.netId}`,
      });
    }

    if (targets.length === 0) {
      console.log(
        `No unmapped students to mine for course '${courseId}' (--only-missing=${onlyMissing}).`,
      );
      console.log(`  already-had-mapping: ${alreadyHadMapping}`);
      console.log(`  total enabled students: ${totalEnabled}`);
      return 0;
    }

    const retryOpts = {
      retries: 5,
      delayMs: 2000,
      exponentialBackoff: true,
      maxDelayMs: 30000,
      onError: async (error: any) => {
        if (error?.retryAfterMs) {
          logger.warn(
            { retryAfterMs: error.retryAfterMs },
            "Rate limited; honoring Retry-After before retry",
          );
          await sleep(error.retryAfterMs);
        }
      },
    };

    let mined = 0;
    let anomalous = 0;
    let repoNotFound = 0;
    let upsertFailed = 0;
    const distribution = new Map<number, number>();
    let sampleNotFound = 0;
    let sampleError = 0;
    let reposSampled = 0;

    for (const { netId, repoName } of targets) {
      let result: CollabResult;
      try {
        result = await retryAsync(
          fetchDirectCollaborators,
          retryOpts,
          githubOrg,
          repoName,
          githubToken,
          logger,
        );
      } catch (e) {
        logger.error(
          { netId, repoName, err: e instanceof Error ? e.message : String(e) },
          "Failed to fetch collaborators after retries",
        );
        repoNotFound++;
        if (reposSampled < sampleSize) {
          sampleError++;
          reposSampled++;
        }
        continue;
      }

      if (reposSampled < sampleSize) {
        reposSampled++;
        if (result.kind === "ok") {
          const c = result.collaborators.length;
          distribution.set(c, (distribution.get(c) ?? 0) + 1);
        } else if (result.kind === "notFound") {
          sampleNotFound++;
        } else {
          sampleError++;
        }
      }

      if (result.kind === "error") {
        logger.warn(
          { netId, repoName, message: result.message },
          "GitHub API error fetching collaborators",
        );
        repoNotFound++;
        continue;
      }
      if (result.kind === "notFound") {
        logger.warn({ netId, repoName }, "Repo not found or inaccessible");
        repoNotFound++;
        continue;
      }

      const collaborators = result.collaborators;
      if (collaborators.length !== 1) {
        logger.warn(
          {
            netId,
            repoName,
            count: collaborators.length,
            logins: collaborators.map((c) => c.login),
          },
          "Anomalous collaborator count (expected exactly 1)",
        );
        anomalous++;
        continue;
      }

      const { login, name } = collaborators[0];

      const conflict = await prismaClient.githubUsernameMapping.findUnique({
        where: { courseId_githubUsername: { courseId, githubUsername: login } },
      });
      if (conflict && conflict.netId !== netId) {
        logger.warn(
          { netId, repoName, login, otherNetId: conflict.netId },
          "GitHub username already mapped to a different netId; skipping upsert",
        );
        anomalous++;
        continue;
      }

      const existing = existingByNetId.get(netId);
      if (existing && existing.githubUsername !== login) {
        logger.warn(
          { netId, oldLogin: existing.githubUsername, newLogin: login },
          "GitHub username changed for student (possible account change); updating",
        );
      }

      try {
        await prismaClient.githubUsernameMapping.upsert({
          where: { courseId_netId: { courseId, netId } },
          update: {
            githubUsername: login,
            githubName: name ?? null,
            minedAt: new Date(),
          },
          create: {
            courseId,
            netId,
            githubUsername: login,
            githubName: name ?? null,
          },
        });
        mined++;
        existingByNetId.set(netId, {
          githubUsername: login,
          githubName: name ?? null,
        });
      } catch (e) {
        logger.error(
          { netId, repoName, login, err: e instanceof Error ? e.message : String(e) },
          "Upsert failed for GithubUsernameMapping",
        );
        upsertFailed++;
      }
    }

    console.log(
      `\nCollaborator-count distribution (first ${sampleSize} repos queried):`,
    );
    if (reposSampled === 0) {
      console.log("  (no repos queried)");
    } else {
      for (const [count, numRepos] of [...distribution.entries()].sort(
        (a, b) => a[0] - b[0],
      )) {
        console.log(`  ${count} collaborator(s): ${numRepos} repo(s)`);
      }
      if (sampleNotFound > 0) {
        console.log(`  not-found/inaccessible: ${sampleNotFound} repo(s)`);
      }
      if (sampleError > 0) {
        console.log(`  error: ${sampleError} repo(s)`);
      }
    }

    const withMapping = mined + alreadyHadMapping;
    const yieldPct =
      totalEnabled > 0 ? (withMapping / totalEnabled) * 100 : 100;

    console.log(`\nGitHub username mining complete for course '${courseId}':`);
    console.log(`  mined: ${mined}`);
    console.log(`  already-had-mapping: ${alreadyHadMapping}`);
    console.log(`  anomalous-collaborator-count: ${anomalous}`);
    console.log(`  repo-not-found: ${repoNotFound}`);
    if (upsertFailed > 0) console.log(`  upsert-failed: ${upsertFailed}`);
    console.log(`  total enabled students: ${totalEnabled}`);
    console.log(
      `  yield: ${withMapping}/${totalEnabled} (${yieldPct.toFixed(1)}%)`,
    );

    if (yieldPct < 90) {
      console.error(
        `\nYield ${yieldPct.toFixed(1)}% is below the 90% threshold; exiting non-zero.`,
      );
      return 1;
    }
    return 0;
  } finally {
    await prismaClient.$disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
