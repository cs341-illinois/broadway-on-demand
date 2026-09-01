import moment from "moment-timezone";
import { Prisma, PrismaClient, Role } from "../generated/prisma/client.js";
import {
  PARTNER_GROUP_SYSTEM_CREATOR,
  PARTNER_ROTATION_WEEKS,
} from "../constants.js";
import { getAssignmentDueDate } from "./assignment.js";

type Tx = PrismaClient | Prisma.TransactionClient;

/**
 * 0-based index of the PARTNER_ROTATION_WEEKS-long window `date` falls into,
 * counted from Course.firstLabDate. Dates at or before firstLabDate are
 * period 0.
 */
export function getPartnerRotationPeriodIndex({
  firstLabDate,
  date,
}: {
  firstLabDate: Date;
  date: Date;
}): number {
  const weeksSince = moment(date).diff(moment(firstLabDate), "weeks");
  return Math.max(0, Math.floor(weeksSince / PARTNER_ROTATION_WEEKS));
}

function shuffle<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * Randomly splits netIds into groups of 2, folding a leftover single
 * (odd-sized input) into the last group to make one group of 3 instead of
 * leaving anyone ungrouped.
 */
export function generateRandomGroups(netIds: string[]): string[][] {
  const shuffled = shuffle(netIds);
  const groups: string[][] = [];
  for (let i = 0; i < shuffled.length; i += 2) {
    groups.push(shuffled.slice(i, i + 2));
  }
  const last = groups[groups.length - 1];
  if (last && last.length === 1 && groups.length > 1) {
    groups[groups.length - 2].push(last[0]);
    groups.pop();
  }
  return groups;
}

/**
 * Generates and persists partner groups for every lab section in a course
 * that doesn't already have groups for this period (staff-created or
 * previously auto-generated groups are left untouched, which is also what
 * makes this safe to call more than once for the same period).
 */
export async function runPartnerRotationForCourse({
  tx,
  courseId,
  periodIndex,
}: {
  tx: Prisma.TransactionClient;
  courseId: string;
  periodIndex: number;
}): Promise<{ sectionsGrouped: string[]; sectionsSkipped: string[] }> {
  const students = await tx.users.findMany({
    where: {
      courseId,
      role: Role.STUDENT,
      enabled: true,
      labSection: { not: null },
    },
    select: { netId: true, labSection: true },
  });

  const bySection = new Map<string, string[]>();
  for (const student of students) {
    const section = student.labSection as string;
    const list = bySection.get(section) ?? [];
    list.push(student.netId);
    bySection.set(section, list);
  }

  const sectionsGrouped: string[] = [];
  const sectionsSkipped: string[] = [];

  for (const [labSection, sectionNetIds] of bySection) {
    const existing = await tx.partnerGroup.findFirst({
      where: { courseId, labSection, periodIndex },
      select: { id: true },
    });
    if (existing) {
      sectionsSkipped.push(labSection);
      continue;
    }

    for (const memberNetIds of generateRandomGroups(sectionNetIds)) {
      await tx.partnerGroup.create({
        data: {
          courseId,
          labSection,
          periodIndex,
          createdBy: PARTNER_GROUP_SYSTEM_CREATOR,
          members: {
            create: memberNetIds.map((netId) => ({ courseId, netId, periodIndex })),
          },
        },
      });
    }
    sectionsGrouped.push(labSection);
  }

  return { sectionsGrouped, sectionsSkipped };
}

/**
 * The partner group (if any) a student belongs to for a given rotation
 * period, including all of that group's members.
 */
export async function getGroupForStudent({
  tx,
  courseId,
  netId,
  periodIndex,
}: {
  tx: Tx;
  courseId: string;
  netId: string;
  periodIndex: number;
}) {
  const member = await tx.partnerGroupMember.findUnique({
    where: { courseId_netId_periodIndex: { courseId, netId, periodIndex } },
    include: {
      PartnerGroup: {
        include: { members: { include: { Users: { select: { name: true } } } } },
      },
    },
  });
  return member?.PartnerGroup ?? null;
}

/**
 * Resolves the rotation period an assignment's due date falls into, for
 * looking up the groups that should apply to it. Returns null if the
 * assignment has no scheduled due date (mirrors getAssignmentDueDate).
 */
export async function getPeriodIndexForAssignment({
  tx,
  courseId,
  assignmentId,
}: {
  tx: Prisma.TransactionClient;
  courseId: string;
  assignmentId: string;
}): Promise<number | null> {
  const dueDate = await getAssignmentDueDate({ tx, courseId, assignmentId });
  if (!dueDate) {
    return null;
  }
  const { firstLabDate } = await tx.course.findFirstOrThrow({
    where: { id: courseId },
    select: { firstLabDate: true },
  });
  return getPartnerRotationPeriodIndex({
    firstLabDate,
    date: dueDate.toDate(),
  });
}
