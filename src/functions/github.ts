import { type RedisClientType } from "redis";
import { Octokit } from "@octokit/rest";
import { FastifyBaseLogger } from "fastify";
import { retryAsync } from "./utils.js";
import { GradeEntry } from "./grades.js";
import { parse } from "csv-parse/sync";
import { RequestError } from "@octokit/request-error";
import { DatabaseFetchError } from "../errors/index.js";

type UpdateStudentGradesGithubInput = {
  redisClient: RedisClientType;
  assignmentId: string;
  gradeData: { netId: string; score: number; comments?: string }[];
  githubToken: string;
  commitMessage: string;
  overwrite?: boolean;
  orgName: string;
  repoName: string;
  logger: FastifyBaseLogger;
};

export type RosterEntry = { netId: string; labSection?: string | null };

type OverwriteRosterGithubInput = {
  redisClient: RedisClientType;
  rosterEntries: RosterEntry[];
  githubToken: string;
  commitMessage: string;
  overwrite?: boolean;
  orgName: string;
  repoName: string;
  logger: FastifyBaseLogger;
};

export async function updateStudentGradesToGithub({
  redisClient,
  assignmentId,
  gradeData,
  commitMessage,
  githubToken,
  orgName,
  repoName,
  overwrite = false,
  logger,
}: UpdateStudentGradesGithubInput) {
  let error: any;
  await retryAsync(async () => {
    const lockTs = new Date().getTime();
    const lockId = `ghe_lock:${assignmentId}`;
    const githubClient = new Octokit({
      auth: githubToken,
    });
    try {
      await githubClient.rest.orgs.get({ org: orgName });
    } catch (e) {
      logger.error(e);
      throw new DatabaseFetchError({
        message: "Failed to get GitHub organization.",
      });
    }
    try {
      await githubClient.rest.repos.get({ owner: orgName, repo: repoName });
    } catch (e) {
      logger.error(e);
      throw new DatabaseFetchError({
        message: "Failed to get GitHub repository.",
      });
    }
    try {
      logger.debug(`Acquiring lock ${lockId}`);
      const response = await redisClient.set(lockId, lockTs, {
        NX: true,
        PX: 30000,
      });
      if (!response) {
        throw new Error(
          `Someone else already holds the lock for assignment ID ${assignmentId}`,
        );
      }
      try {
        const { content: oldContent, sha: previousSha } =
          await getGradeFileFromGithub({
            githubOrg: orgName,
            githubRepo: repoName,
            assignmentId,
            githubClient,
          });

        let newGradeData = gradeData;
        if (oldContent) {
          const oldGradesData = overwrite ? [] : parseGradesCsvData(oldContent);
          newGradeData = overwrite
            ? gradeData
            : insertOrUpdateGradeEntries(oldGradesData, gradeData);
        }

        await createOrUpdateGradesFileToGhe({
          githubOrg: orgName,
          githubRepo: repoName,
          githubClient,
          commitMessage,
          assignmentId,
          gradesData: newGradeData,
          previousSha,
        });
      } catch (e: any) {
        if (e instanceof RequestError && e.status === 409) {
          logger.warn(`Conflict (409) detected on ${assignmentId}. Retrying.`);
          throw e;
        }
        error = e;
        logger.error("Found non-retryable error", e);
      }
    } finally {
      logger.debug(`Releasing lock ${lockId}`);
      const lockValue = await redisClient.get(lockId);
      if (!lockValue) {
        logger.error(
          "Lock was already released before we finished, this is bad!",
        );
        return;
      }
      const retrievedLockTs = parseInt(lockValue, 10);
      if (lockTs !== retrievedLockTs) {
        logger.error(
          "Lock was already released and reset before we finished, this is bad!",
        );
        return;
      }
      await redisClient.del(lockId);
      logger.debug("Released job lock.");
    }
  });
  if (error) {
    throw error;
  }
}

interface OctokitFileData {
  type: string;
  content: string;
  sha: string;
}

async function getFileFromGithub({
  githubOrg,
  githubRepo,
  filePath,
  githubClient,
}: {
  githubOrg: string;
  githubRepo: string;
  filePath: string;
  githubClient: Octokit;
}): Promise<{
  content: null | string;
  sha: null | string;
}> {
  try {
    const res = await githubClient.rest.repos
      .getContent({
        owner: githubOrg,
        repo: githubRepo,
        path: filePath,
      })
      .catch((error) => {
        if (error.status && error.status === 404) {
          return null;
        }
        throw error;
      });
    if (res === null) {
      return { content: null, sha: null };
    }
    const data = res.data as OctokitFileData;
    if (data.type !== "file") {
      return { content: null, sha: null };
    }
    return {
      content: Buffer.from(data.content, "base64").toString(),
      sha: data.sha,
    };
  } catch (error) {
    // A 404 is not an operational error; it just means the file doesn't exist yet.
    if (error instanceof RequestError && error.status === 404) {
      return { content: null, sha: null };
    }
    throw error;
  }
}

async function getGradeFileFromGithub({
  githubOrg,
  githubRepo,
  assignmentId,
  githubClient,
}: {
  githubOrg: string;
  githubRepo: string;
  assignmentId: string;
  githubClient: Octokit;
}): Promise<{
  content: null | string;
  sha: null | string;
}> {
  const filePath = `grade_csvs/${assignmentId}.csv`;
  return await getFileFromGithub({
    githubClient,
    githubOrg,
    githubRepo,
    filePath,
  });
}

function generateGradesCsv(gradesData: GradeEntry[]) {
  const header = `"netid","score","comments"\n`;
  const values = gradesData
    .map(
      (entry) =>
        `"${entry.netId}","${entry.score}","${(entry.comments || "").replaceAll(`"`, `""`)}"`,
    )
    .join("\n");
  return header + values;
}

function generateRosterCsv(rosterEntries: RosterEntry[]) {
  const header = "netid,section\n";
  const seen = new Set<string>();
  const values = rosterEntries
    .filter((entry) => {
      if (seen.has(entry.netId)) return false;
      seen.add(entry.netId);
      return true;
    })
    .map((entry) => `${entry.netId},${entry.labSection || ""}`)
    .join("\n");
  return header + values;
}

/**
 * Update existing grades data with a new set of data
 * @param gradesData Existing grades data
 * @param newData New data that we want to insert or update into gradesData
 * @returns Merged grades data (which is a reference to gradesData)
 */
function insertOrUpdateGradeEntries(
  gradesData: GradeEntry[],
  newData: GradeEntry[],
) {
  for (const newEntry of newData) {
    const oldEntry = gradesData.find((entry) => entry.netId === newEntry.netId);
    if (oldEntry == null) {
      gradesData.push({
        netId: newEntry.netId,
        score: newEntry.score,
        comments: "",
      });
    } else {
      oldEntry.score = newEntry.score;
      oldEntry.comments = newEntry.comments || "";
    }
  }
  return gradesData;
}

function parseGradesCsvData(csvData: string) {
  const parseResult = parse(csvData, {
    columns: true,
    skip_empty_lines: true,
  }).map((x: any) => ({
    netId: x.netid,
    score: parseInt(x.score, 10),
    comments: x.comments || "",
  })) as GradeEntry[];
  return parseResult;
}

/**
 * Overwrite or create a grades csv file to GHE using Github API
 * @param assignmentName Assignment name (file name before .csv)
 * @param gradesData This data will be used to generate csv file
 * @param commitMessage Commit message
 * @param sha SHA hash of previous version of the file (if we are overwriting it)
 */
async function createOrUpdateGradesFileToGhe({
  githubOrg,
  githubRepo,
  assignmentId,
  gradesData,
  commitMessage,
  previousSha,
  githubClient,
}: {
  assignmentId: string;
  gradesData: GradeEntry[];
  commitMessage: string;
  previousSha: string | null;
  githubClient: Octokit;
  githubOrg: string;
  githubRepo: string;
}): Promise<void> {
  const fileContent = generateGradesCsv(gradesData);
  const filePath = `grade_csvs/${assignmentId}.csv`;
  await createOrUpdateFileToGhe({
    githubOrg,
    githubRepo,
    fileContent,
    filePath,
    commitMessage,
    previousSha,
    githubClient,
  });
}

async function createOrUpdateFileToGhe({
  githubOrg,
  githubRepo,
  filePath,
  fileContent,
  commitMessage,
  previousSha,
  githubClient,
}: {
  filePath: string;
  commitMessage: string;
  previousSha: string | null;
  githubClient: Octokit;
  githubOrg: string;
  githubRepo: string;
  fileContent: string;
}): Promise<void> {
  await githubClient.repos.createOrUpdateFileContents({
    owner: githubOrg,
    repo: githubRepo,
    path: filePath,
    message: commitMessage,
    content: Buffer.from(fileContent).toString("base64"),
    committer: {
      name: "CS 341 Infrastructure",
      email: "cs341admin@illinois.edu",
    },
    sha: previousSha == null ? undefined : previousSha,
    branch: "main",
  });
}

export async function overwriteRosterToGithub({
  redisClient,
  rosterEntries,
  commitMessage,
  githubToken,
  orgName,
  repoName,
  logger,
}: OverwriteRosterGithubInput) {
  let error: any;
  const githubClient = new Octokit({
    auth: githubToken,
  });
  try {
    await githubClient.rest.orgs.get({ org: orgName });
  } catch (e) {
    logger.error(e);
    throw new DatabaseFetchError({
      message: "Failed to get GitHub organization.",
    });
  }
  try {
    await githubClient.rest.repos.get({ owner: orgName, repo: repoName });
  } catch (e) {
    logger.error(e);
    throw new DatabaseFetchError({
      message: "Failed to get GitHub repository.",
    });
  }
  await retryAsync(async () => {
    const lockTs = new Date().getTime();
    const lockId = `ghe_lock:roster:${orgName}:${repoName}`;
    try {
      logger.debug(`Acquiring lock ${lockId}`);
      const response = await redisClient.set(lockId, lockTs, {
        NX: true,
        PX: 30000,
      });
      if (!response) {
        throw new Error(`Someone else already holds the lock for ${repoName}`);
      }

      try {
        const { sha: previousSha } = await getFileFromGithub({
          githubOrg: orgName,
          githubRepo: repoName,
          filePath: "roster.csv",
          githubClient,
        });

        const fileContent = generateRosterCsv(rosterEntries);
        await createOrUpdateFileToGhe({
          githubOrg: orgName,
          githubRepo: repoName,
          githubClient,
          commitMessage,
          filePath: "roster.csv",
          fileContent,
          previousSha,
        });
      } catch (e: any) {
        if (e instanceof RequestError && e.status === 409) {
          logger.warn(`Conflict (409) detected on roster. Retrying.`);
          throw e; // Re-throw for retry
        }
        error = e;
        logger.error("Found non-retryable error", e);
      }
    } finally {
      logger.debug(`Releasing lock ${lockId}`);
      const lockValue = await redisClient.get(lockId);
      if (!lockValue) {
        logger.error(
          "Lock was already released before we finished, this is bad!",
        );
        return;
      }
      const retrievedLockTs = parseInt(lockValue, 10);
      if (lockTs !== retrievedLockTs) {
        logger.error(
          "Lock was already released and reset before we finished, this is bad!",
        );
        return;
      }
      await redisClient.del(lockId);
      logger.debug("Released roster lock.");
    }
  });
  if (error) {
    throw error;
  }
}

/**
 * Adds a single user as a direct collaborator on a single repo. Scoped
 * counterpart to the full syncAccess sweep (which lists/adds/removes across
 * every repo in a project) — use this right after a targeted assignment
 * (e.g. manual assign) so the student doesn't wait for the next bulk sync.
 * Returns added: true for a fresh invite (201), false if they already had
 * access (204, GitHub's response for an existing collaborator).
 */
export async function addRepoCollaborator({
  githubToken,
  orgName,
  repoName,
  username,
  logger,
}: {
  githubToken: string;
  orgName: string;
  repoName: string;
  username: string;
  logger: FastifyBaseLogger;
}): Promise<{ added: boolean }> {
  const res = await fetch(
    `https://api.github.com/repos/${orgName}/${repoName}/collaborators/${username}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ permission: "push" }),
    },
  );
  if (res.status !== 201 && res.status !== 204) {
    logger.error(
      { orgName, repoName, username, status: res.status },
      "Failed to add GitHub collaborator",
    );
    throw new Error(
      `Failed to add collaborator ${username} to ${repoName}: HTTP ${res.status}`,
    );
  }
  return { added: res.status === 201 };
}

export async function removeRepoCollaborator({
  githubToken,
  orgName,
  repoName,
  username,
  logger,
}: {
  githubToken: string;
  orgName: string;
  repoName: string;
  username: string;
  logger: FastifyBaseLogger;
}): Promise<{ removed: boolean }> {
  const res = await fetch(
    `https://api.github.com/repos/${orgName}/${repoName}/collaborators/${username}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
      },
    },
  );
  if (res.status !== 204 && res.status !== 404) {
    logger.error(
      { orgName, repoName, username, status: res.status },
      "Failed to remove GitHub collaborator",
    );
    throw new Error(
      `Failed to remove collaborator ${username} from ${repoName}: HTTP ${res.status}`,
    );
  }
  return { removed: res.status === 204 };
}

/**
 * Creates a private repo in the org with an initial commit (auto_init), for
 * the on-demand project-repo flow. Idempotent: GitHub's 422 "name already
 * exists" is treated as success ({ alreadyExisted: true }) so provisioning
 * can safely retry half-completed repos.
 *
 * Privacy belt-and-suspenders: the create call pins private: true (the API
 * default is false!), the 201 response is verified to actually be private,
 * and a public result is remediated via PATCH before failing loudly.
 */
export async function createOrgRepo({
  githubToken,
  orgName,
  repoName,
  logger,
}: {
  githubToken: string;
  orgName: string;
  repoName: string;
  logger: FastifyBaseLogger;
}): Promise<{ alreadyExisted: boolean }> {
  const headers = {
    Authorization: `Bearer ${githubToken}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
  };
  let res = await fetch(`https://api.github.com/orgs/${orgName}/repos`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: repoName,
      private: true,
      auto_init: true,
      has_issues: false,
      has_projects: false,
      has_wiki: false,
    }),
  });
  if (res.status === 422) {
    // Name already exists on GitHub - safe to treat as success (idempotent retry).
    return { alreadyExisted: true };
  }
  if (res.status !== 201) {
    const body = await res.text().catch(() => "");
    logger.error(
      { orgName, repoName, status: res.status, body },
      "Failed to create GitHub repo",
    );
    throw new Error(
      `Failed to create repo ${orgName}/${repoName}: HTTP ${res.status}`,
    );
  }
  const created = (await res.json()) as { private?: boolean };
  if (created.private !== true) {
    // Should never happen since we passed private: true - remediate immediately.
    logger.error({ orgName, repoName }, "Created repo is not private; patching");
    const patchRes = await fetch(
      `https://api.github.com/repos/${orgName}/${repoName}`,
      { method: "PATCH", headers, body: JSON.stringify({ private: true }) },
    );
    if (patchRes.status !== 200) {
      throw new Error(
        `Repo ${orgName}/${repoName} was created PUBLIC and could not be patched private (HTTP ${patchRes.status}) - fix manually immediately.`,
      );
    }
  }
  return { alreadyExisted: false };
}

/**
 * Grants a GitHub team access to a repo (PUT /orgs/{org}/teams/{slug}/repos).
 * Requires the token's user to have admin on the repo (the repo creator does)
 * and to be able to see the team (org owners see secret teams too).
 */
export async function addTeamRepoAccess({
  githubToken,
  orgName,
  teamSlug,
  repoName,
  permission = "maintain",
  logger,
}: {
  githubToken: string;
  orgName: string;
  teamSlug: string;
  repoName: string;
  permission?: string;
  logger: FastifyBaseLogger;
}): Promise<void> {
  const res = await fetch(
    `https://api.github.com/orgs/${orgName}/teams/${teamSlug}/repos/${orgName}/${repoName}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ permission }),
    },
  );
  if (res.status !== 204) {
    const body = await res.text().catch(() => "");
    logger.error(
      { orgName, teamSlug, repoName, status: res.status, body },
      "Failed to grant team repo access",
    );
    throw new Error(
      `Failed to grant team '${teamSlug}' access to ${repoName}: HTTP ${res.status}`,
    );
  }
}


export async function getLatestCommit({
  githubToken,
  orgName,
  repoName,
  logger,
}: {
  githubToken: string;
  orgName: string;
  repoName: string;
  logger: FastifyBaseLogger;
}): Promise<{
  sha: string;
  message: string;
  url: string;
  date?: string;
} | null> {
  const githubClient = new Octokit({
    auth: githubToken,
  });

  try {
    const response = await githubClient.rest.repos.listCommits({
      owner: orgName,
      repo: repoName,
      per_page: 1,
      page: 1,
    });

    if (response.data && response.data.length > 0) {
      const latestCommit = response.data[0];
      return {
        sha: latestCommit.sha,
        message: latestCommit.commit.message,
        url: latestCommit.html_url,
        date: latestCommit.commit.author?.date,
      };
    } else {
      logger.warn(
        `No commits found for ${orgName}/${repoName}. The repository might be empty or does not exist.`,
      );
    }
  } catch (error: any) {
    logger.error(error);
    if (error.status === 404) {
      logger.warn(
        `Repository ${orgName}/${repoName} not found. Please check the organization and repository names.`,
      );
    }
    logger.warn(
      `Failed to fetch the latest commit for ${orgName}/${repoName}: ${error.message}`,
    );
    return null;
  }
  return null;
}
