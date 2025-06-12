import { z, ZodError } from "zod";
import inquirer from "inquirer";
import moment from "moment-timezone";
import {
  splitCourseIdString,
  capitalizeFirstLetterOnly,
} from "../functions/utils.js";
import { PrismaClient } from "../generated/prisma/client.js";
import { netIdSchema } from "../types/index.js";
import dotenv from "dotenv";
dotenv.config();
if (!process.env.DATABASE_URL) {
  throw new Error(
    "Failed to find DATABASE_URL environment variable to connect to database!",
  );
}

import { Role } from "../generated/prisma/enums.js";

const isValidTimeZone = (tz: string): boolean => {
  return !!moment.tz.zone(tz);
};

function parseAndConvertToISO(
  dateTimeStr: string,
  timeZone: string,
): string | null {
  try {
    const momentDate = moment.tz(
      dateTimeStr,
      "MM/DD/YYYY HH:mm",
      true,
      timeZone,
    );
    if (!momentDate.isValid()) {
      return null;
    }
    momentDate.seconds(0).milliseconds(0);
    return momentDate.utc().format();
  } catch (error) {
    return null;
  }
}

const getPreviousSemesterString = (
  semesterCode: string,
  yearCode: string,
): string | null => {
  const year = parseInt(yearCode, 10);
  if (isNaN(year)) return null;

  if (semesterCode.toLowerCase() === "fa") {
    return `sp${yearCode}`;
  }
  if (semesterCode.toLowerCase() === "sp") {
    return `fa${year - 1}`;
  }
  return null;
};

export const CourseSchema = z.object({
  id: z.string().min(1, {
    message:
      "ID cannot be empty. This is the user-provided unique identifier for the course.",
  }),
  githubOrg: z.string().min(1, {
    message: "GitHub organization cannot be empty (e.g., 'your-org-name').",
  }),
  githubRepoPrefix: z.string().min(1, {
    message:
      "GitHub repository prefix cannot be empty (e.g., 'fall2025-cs101-').",
  }),
  githubToken: z.string(),
  name: z.string().min(1, {
    message:
      "Course name cannot be empty (e.g., 'Introduction to Programming').",
  }),
  jenkinsToken: z.string(),
  feedbackBranchName: z
    .string()
    .min(1, { message: "Feedback branch name cannot be empty." })
    .default("feedback"),
  courseCutoff: z.coerce.date({
    errorMap: (issue, { defaultError }) => ({
      message:
        issue.code === "invalid_date"
          ? "Invalid course cutoff date (post-conversion)."
          : defaultError,
    }),
  }),
  jenkinsBaseUrl: z.string().url({
    message: "Invalid Jenkins base URL (e.g., 'https://jenkins.example.com').",
  }),
  courseTimezone: z.string().refine(isValidTimeZone, {
    message:
      "Invalid IANA timezone string (e.g., 'America/Chicago', 'Europe/London').",
  }),
  gradesRepo: z
    .string()
    .min(1, { message: "Grades repository name/URL cannot be empty." }),
  rosterRepo: z
    .string()
    .min(1, { message: "Roster repository name/URL cannot be empty." }),
  firstLabDate: z.coerce.date({
    errorMap: (issue, { defaultError }) => ({
      message:
        issue.code === "invalid_date"
          ? "Invalid first lab date (post-conversion)."
          : defaultError,
    }),
  }),
  numExtensions: z.coerce
    .number()
    .int()
    .nonnegative({
      message: "Number of extensions must be a non-negative integer.",
    })
    .default(0),
  numExtensionHours: z.coerce
    .number()
    .int()
    .nonnegative({
      message: "Number of extension hours must be a non-negative integer.",
    })
    .default(24),
});

export type CourseInput = z.infer<typeof CourseSchema>;

interface RemainingCourseAnswers {
  name: string;
  githubOrg: string;
  githubRepoPrefix: string;
  githubToken: string;
  jenkinsBaseUrl: string;
  jenkinsToken: string;
  feedbackBranchName: string;
  courseCutoff: string;
  gradesRepo: string;
  rosterRepo: string;
  firstLabDate: string;
  numExtensions: number;
  numExtensionHours: number;
}

async function createCourseCLI(): Promise<void> {
  console.log("Welcome to the Broadway Course Creation CLI");
  console.log("Please provide the details for the new course.");
  console.log("--------------------------------------------------");

  try {
    const preliminaryAnswers = await inquirer.prompt<{
      id: string;
      courseTimezone: string;
    }>([
      {
        type: "input",
        name: "id",
        message: "Unique Course ID (e.g., cs341-sp25):",
        validate: (input: string) => {
          if (!input || input.trim().length === 0) {
            return "Course ID cannot be empty.";
          }
          const parts = splitCourseIdString(input.trim());
          if (!parts) {
            return 'Could not parse course ID. Format: <dept><num>-<term><year> (e.g., "cs341-sp25").';
          }
          return true;
        },
      },
      {
        type: "input",
        name: "courseTimezone",
        message: "Course Timezone (IANA format, e.g., America/Chicago):",
        default: moment.tz.guess(),
        validate: (input: string) =>
          isValidTimeZone(input) ||
          "Invalid IANA timezone. Examples: America/Chicago, America/New_York.",
      },
    ]);

    const { id: courseId, courseTimezone } = preliminaryAnswers;
    const parts = splitCourseIdString(courseId.trim())!;

    const previousSemesterTermString = getPreviousSemesterString(
      parts.semesterCode,
      parts.yearCode,
    );
    const previousCourseId = previousSemesterTermString
      ? `${parts.department}${parts.courseNumber}-${previousSemesterTermString}`
      : null;

    const semesterCodeMapper: { [key: string]: string } = {
      sp: "Spring",
      fa: "Fall",
      su: "Summer",
    };
    const termName = capitalizeFirstLetterOnly(
      semesterCodeMapper[
        parts.semesterCode.toLowerCase() as keyof typeof semesterCodeMapper
      ] || parts.semesterCode,
    );
    const defaultCourseName = `${parts.department.toUpperCase()} ${parts.courseNumber} ${termName} 20${parts.yearCode}`;
    const courseIdNoTerm = `${parts.department}${parts.courseNumber}`;
    const termId = `${parts.semesterCode.toLowerCase()}${parts.yearCode}`;

    const tokenMessageSuffix = previousCourseId
      ? ` (leave empty to try using from ${previousCourseId})`
      : " (input hidden)";

    const questionsForRemaining = [
      {
        type: "input",
        name: "name",
        message: "Course Name:",
        default: defaultCourseName,
        validate: (input: string) => !!input.trim() || "Name cannot be empty.",
      },
      {
        type: "input",
        name: "githubOrg",
        message: "GitHub Organization:",
        default: "illinois-cs-coursework",
        validate: (input: string) =>
          !!input.trim() || "GitHub Org cannot be empty.",
      },
      {
        type: "input",
        name: "githubRepoPrefix",
        message: "GitHub Repository Prefix:",
        default: `${termId}_${courseIdNoTerm}`,
        validate: (input: string) =>
          !!input.trim() || "Repo prefix cannot be empty.",
      },
      {
        type: "password",
        name: "githubToken",
        message: `GitHub Token${tokenMessageSuffix}:`,
        mask: "*",
      },
      {
        type: "input",
        name: "jenkinsBaseUrl",
        message: "Jenkins Base URL:",
        default: `https://grd-${courseIdNoTerm}.cs.illinois.edu/jenkins`,
        validate: (input: string) => {
          try {
            new URL(input);
            return true;
          } catch {
            return "Invalid URL.";
          }
        },
      },
      {
        type: "password",
        name: "jenkinsToken",
        message: `Jenkins Token (base64(user:apiToken))${tokenMessageSuffix}:`,
        mask: "*",
      },
      {
        type: "input",
        name: "feedbackBranchName",
        message: "Default Feedback Branch Name:",
        default: "_feedback",
        validate: (input: string) =>
          !!input.trim() || "Branch name cannot be empty.",
      },
      {
        type: "input",
        name: "firstLabDate",
        message: `First Lab Date (in ${courseTimezone}, format MM/DD/YYYY HH:MM):`,
        validate: (input: string) => {
          if (!input || !input.trim()) return "First Lab Date cannot be empty.";
          return (
            parseAndConvertToISO(input, courseTimezone) !== null ||
            `Invalid date/time. Use MM/DD/YYYY HH:MM for ${courseTimezone}.`
          );
        },
      },
      {
        type: "input",
        name: "courseCutoff",
        message: `Semester Course Cutoff Day/Reading Day (in ${courseTimezone}, format MM/DD/YYYY HH:MM):`,
        validate: (input: string) => {
          if (!input || !input.trim()) return "Course Cutoff cannot be empty.";
          return (
            parseAndConvertToISO(input, courseTimezone) !== null ||
            `Invalid date/time. Use MM/DD/YYYY HH:MM for ${courseTimezone}.`
          );
        },
      },
      {
        type: "input",
        name: "gradesRepo",
        message: "Grades Repository:",
        default: `${termId}_${courseIdNoTerm}_.grades`,
        validate: (input: string) =>
          !!input.trim() || "Grades repo cannot be empty.",
      },
      {
        type: "input",
        name: "rosterRepo",
        message: "Roster Repository:",
        default: `${termId}_${courseIdNoTerm}_.roster`,
        validate: (input: string) =>
          !!input.trim() || "Roster repo cannot be empty.",
      },
      {
        type: "number",
        name: "numExtensions",
        message: "Default Number of Self assignment Extensions Allowed:",
        default: 3,
        validate: (input: number) =>
          (Number.isInteger(input) && input >= 0) ||
          "Must be a non-negative integer.",
      },
      {
        type: "number",
        name: "numExtensionHours",
        message: "Default Duration of Each Extension in Hours:",
        default: 48,
        validate: (input: number) =>
          (Number.isInteger(input) && input >= 0) ||
          "Must be a non-negative integer.",
      },
    ];

    const remainingAnswers = await inquirer.prompt<RemainingCourseAnswers>(
      questionsForRemaining as any,
    );
    const { netId: firstAdminNetId } = await inquirer.prompt<{ netId: string }>(
      [
        {
          type: "input",
          name: "netId",
          message: "NetID for first user (granted ADMIN role):",
          validate: (value: string) => {
            const result = netIdSchema.safeParse(value);
            if (!result.success) {
              return "Invalid NetID (must follow UIUC NetID rules).";
            }
            return true;
          },
        },
      ],
    );

    const allAnswers = {
      ...preliminaryAnswers,
      ...remainingAnswers,
    };

    let validatedData: CourseInput = CourseSchema.parse(allAnswers);

    console.log("\n✅ Course data validated successfully!");
    console.log("--------------------------------------------------");
    console.log("Collected and Validated Course Data (Dates are ISO UTC):");
    const displayData = { ...validatedData } as any;

    const tokenDisplay = (tokenVal: string, forWhichToken: string) => {
      if (tokenVal && tokenVal !== "") return "********";
      if (tokenVal === "" && previousCourseId)
        return `<empty (will attempt to use from ${previousCourseId} for ${forWhichToken})>`;
      return "<empty>";
    };

    displayData.githubToken = tokenDisplay(validatedData.githubToken, "GitHub");
    displayData.jenkinsToken = tokenDisplay(
      validatedData.jenkinsToken,
      "Jenkins",
    );
    console.log(JSON.stringify(displayData, null, 2));
    console.log("--------------------------------------------------");
    if (!validatedData.githubToken || !validatedData.jenkinsToken) {
      if (previousCourseId) {
        console.log(
          `ℹ️ Note: Empty tokens will attempt to be sourced from the previous course: ${previousCourseId}`,
        );
      } else {
        console.error(
          "⚠️ Warning: One or more tokens are empty, and no previous course ID could be determined to fetch them.",
        );
      }
    }
    const prismaClient = new PrismaClient();
    if (!validatedData.githubToken && previousCourseId) {
      const { githubToken: oldGithubToken } =
        await prismaClient.course.findFirstOrThrow({
          where: { id: previousCourseId },
          select: { githubToken: true },
        });
      validatedData.githubToken = oldGithubToken;
    }
    if (!validatedData.jenkinsToken && previousCourseId) {
      const { jenkinsToken: oldJenkinsToken } =
        await prismaClient.course.findFirstOrThrow({
          where: { id: previousCourseId },
          select: { jenkinsToken: true },
        });
      validatedData.jenkinsToken = oldJenkinsToken;
    }
    await prismaClient.$transaction(async (tx) => {
      await tx.course.create({ data: validatedData });
      await tx.users.create({
        data: {
          courseId,
          role: Role.ADMIN,
          enabled: true,
          netId: firstAdminNetId,
        },
      });
    });
    console.log("Success!");
  } catch (error) {
    if (error instanceof ZodError) {
      console.error(
        "\n❌ Validation Failed (final check). Please correct the following errors:",
      );
      error.errors.forEach((err) => {
        const field = err.path.join(".");
        console.error(`  - Field: "${field || "general"}" -> ${err.message}`);
      });
    } else if (error instanceof Error && (error as any).isTtyError) {
      console.error(
        "\n❌ Prompts could not be rendered. Try running in a full terminal.",
      );
    } else {
      console.error("\n❌ An unexpected error occurred:", error);
    }
  }
}

createCourseCLI();
