import { Prisma, PrismaClient, Role } from "../generated/prisma/client.js";

type Tx = PrismaClient | Prisma.TransactionClient;

const memberInclude = {
  members: { include: { Users: { select: { name: true } } } },
} satisfies Prisma.PartnerGroupInclude;

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
 * Archives whatever PartnerGroup rows are currently active for this
 * (courseId, labSection, roundNumber), then creates fresh ones from
 * `groupsOfNetIds`. Archived rows stay queryable via
 * getSectionRoundHistory/getStudentPartnerHistory.
 */
export async function archiveAndCreateGroups({
  tx,
  courseId,
  labSection,
  roundNumber,
  groupsOfNetIds,
  actorNetId,
}: {
  tx: Prisma.TransactionClient;
  courseId: string;
  labSection: string;
  roundNumber: number;
  groupsOfNetIds: string[][];
  actorNetId: string;
}) {
  const now = new Date();
  await tx.partnerGroup.updateMany({
    where: { courseId, labSection, roundNumber, archivedAt: null },
    data: { archivedAt: now, archivedBy: actorNetId },
  });

  const created = [];
  for (const memberNetIds of groupsOfNetIds) {
    created.push(
      await tx.partnerGroup.create({
        data: {
          courseId,
          labSection,
          roundNumber,
          createdBy: actorNetId,
          members: {
            create: memberNetIds.map((netId) => ({ courseId, netId, roundNumber })),
          },
        },
        include: memberInclude,
      }),
    );
  }
  return created;
}

/**
 * Whether a section already has an active (non-archived) set of groups for a
 * round - used to gate "generate" (only allowed when there's nothing to
 * overwrite) vs. "regenerate"/"edit" (which always overwrite).
 */
export async function hasActiveGroups({
  tx,
  courseId,
  labSection,
  roundNumber,
}: {
  tx: Tx;
  courseId: string;
  labSection: string;
  roundNumber: number;
}): Promise<boolean> {
  const existing = await tx.partnerGroup.findFirst({
    where: { courseId, labSection, roundNumber, archivedAt: null },
    select: { id: true },
  });
  return !!existing;
}

/**
 * The partner group (if any) a student is currently (non-archived) in for a
 * given round, including all of that group's members.
 */
export async function getGroupForStudent({
  tx,
  courseId,
  netId,
  roundNumber,
}: {
  tx: Tx;
  courseId: string;
  netId: string;
  roundNumber: number;
}) {
  const member = await tx.partnerGroupMember.findFirst({
    where: {
      courseId,
      netId,
      roundNumber,
      PartnerGroup: { archivedAt: null },
    },
    include: { PartnerGroup: { include: memberInclude } },
  });
  return member?.PartnerGroup ?? null;
}

/**
 * Every PartnerGroup (active + archived) for one section+round, newest first.
 */
export async function getSectionRoundHistory({
  tx,
  courseId,
  labSection,
  roundNumber,
}: {
  tx: Tx;
  courseId: string;
  labSection: string;
  roundNumber: number;
}) {
  return tx.partnerGroup.findMany({
    where: { courseId, labSection, roundNumber },
    include: memberInclude,
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Every group a student has ever belonged to (active + archived), across all
 * rounds, ordered chronologically - the admin-facing per-student audit view.
 */
export async function getStudentPartnerHistory({
  tx,
  courseId,
  netId,
}: {
  tx: Tx;
  courseId: string;
  netId: string;
}) {
  const memberships = await tx.partnerGroupMember.findMany({
    where: { courseId, netId },
    include: { PartnerGroup: { include: memberInclude } },
    orderBy: [{ roundNumber: "asc" }, { PartnerGroup: { createdAt: "asc" } }],
  });
  return memberships.map((m) => m.PartnerGroup);
}
