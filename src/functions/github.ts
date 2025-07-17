import { type RedisClientType } from "redis";
import { Octokit } from "@octokit/rest";
import { FastifyBaseLogger } from "fastify";
import { retryAsync } from "./utils.js";
import { GradeEntry } from "./grades.js";
import { parse } from "csv-parse/sync";
import { RequestError } from "@octokit/request-error";
import { InternalServerError } from "../errors/index.js";

type UpdateStudentGradesGithubInput = {
  redisClient: RedisClientType;
  assignmentId: string;
  gradeData: { netId: string; score: number }[];
  githubToken: string;
  commitMessage: string;
  overwrite?: boolean;
  orgName: string;
  repoName: string;
  logger: FastifyBaseLogger;
};

type OverwriteRosterGithubInput = {
  redisClient: RedisClientType;
  netIds: string[];
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
      const githubClient = new Octokit({
        auth: githubToken,
      });
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
      }).catch((e: any) => {
        if (e instanceof RequestError && e.status === 409) {
          throw e; // 409 conflict
        }
        error = e;
        logger.error("Found non-retryable error", e);
      });
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
  const defaultRetVal = { content: null, sha: null };
  try {
    const res = await githubClient.rest.repos.getContent({
      owner: githubOrg,
      repo: githubRepo,
      path: filePath,
    });
    const data = res.data as OctokitFileData;
    if (data.type !== "file") {
      return defaultRetVal;
    }
    return {
      content: Buffer.from(data.content, "base64").toString(),
      sha: data.sha,
    };
  } catch (error) {
    if ((error as any).status !== 404) {
      console.warn(error);
    }
    return defaultRetVal;
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
    .map((entry) => `"${entry.netId}","${entry.score}","${entry.comments}"`)
    .join("\n");
  return header + values;
}

function generateRosterCsv(netIds: string[]) {
  const header = "netid,\n";
  const deduped = [...new Set(netIds)].map((x) => `${x},`);
  const values = deduped.join("\n");
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
      gradesData.push({ netId: newEntry.netId, score: newEntry.score, comments: "" });
    } else {
      oldEntry.score = newEntry.score;
    }
  }
  return gradesData;
}

function parseGradesCsvData(csvData: string) {
  const parseResult = parse(csvData, {
    columns: ["netid", "score", "comments"], // Results look like {netid: ABC, score: 0.0, comments: ""}
    from_line: 2, // Skip headers line
    skip_empty_lines: true,
  }).map((x: any) => ({ netId: x.netid, score: x.score })) as GradeEntry[];
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
  netIds,
  commitMessage,
  githubToken,
  orgName,
  repoName,
  logger,
}: OverwriteRosterGithubInput) {
  let error: any;
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
      const githubClient = new Octokit({
        auth: githubToken,
      });
      const { sha: previousSha } = await getFileFromGithub({
        githubOrg: orgName,
        githubRepo: repoName,
        filePath: "roster.csv",
        githubClient,
      });
      let fileContent = generateRosterCsv(netIds);
      await createOrUpdateFileToGhe({
        githubOrg: orgName,
        githubRepo: repoName,
        githubClient,
        commitMessage,
        filePath: "roster.csv",
        fileContent,
        previousSha,
      }).catch((e: any) => {
        if (e instanceof RequestError && e.status === 409) {
          throw e; // 409 conflict
        }
        error = e;
        logger.error("Found non-retryable error", e);
      });
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
