import { Prisma, PrismaClient } from "../generated/prisma/client.js";

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
 * Canonical key for an (unordered) pair of students, used to track prior
 * partnerships when generating groups.
 */
export function pairKey(netIdA: string, netIdB: string): string {
  return [netIdA, netIdB].sort().join("|");
}

function countRepeatedPairs(
  groups: string[][],
  previousPairs: Set<string>,
): number {
  let conflicts = 0;
  for (const group of groups) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (previousPairs.has(pairKey(group[i], group[j]))) conflicts++;
      }
    }
  }
  return conflicts;
}

/**
 * Randomly splits netIds into groups of 2, folding a leftover single
 * (odd-sized input) into the last group to make one group of 3 instead of
 * leaving anyone ungrouped.
 *
 * `previousPairs` (see getPreviousPartnerPairs) biases the shuffle away from
 * repeating partnerships: many random arrangements are tried and the one with
 * the fewest repeated pairs wins. Best-effort only - when every arrangement
 * must repeat someone (e.g. a previous trio in a 3-student section), the
 * minimum-repeat arrangement is returned.
 */
export function generateRandomGroups(
  netIds: string[],
  previousPairs: Set<string> = new Set(),
): string[][] {
  const buildArrangement = (): string[][] => {
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
  };

  let best = buildArrangement();
  let bestConflicts = countRepeatedPairs(best, previousPairs);
  for (let attempt = 0; attempt < 200 && bestConflicts > 0; attempt++) {
    const candidate = buildArrangement();
    const conflicts = countRepeatedPairs(candidate, previousPairs);
    if (conflicts < bestConflicts) {
      best = candidate;
      bestConflicts = conflicts;
    }
  }
  return best;
}

/**
 * Archives whatever PartnerGroup rows are currently active for this
 * (courseId, labSection, roundNumber), then creates fresh ones from
 * `groupsOfNetIds`. Archived rows stay queryable via
 * getSectionRoundHistory/getStudentPartnerHistory.
 *
 * Groups whose membership is identical to a new group are preserved (not
 * archived) so their ProjectRepoAssignment.sourcePartnerGroupId stays valid.
 * Only groups whose membership actually changed are archived and replaced.
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

  // Fetch currently active groups with their members
  const activeGroups = await tx.partnerGroup.findMany({
    where: { courseId, labSection, roundNumber, archivedAt: null },
    include: { members: { select: { netId: true } } },
  });

  // Build a lookup: sorted-member-key → existing active group
  const activeByKey = new Map<string, string>();
  for (const g of activeGroups) {
    const key = g.members
      .map((m) => m.netId)
      .sort()
      .join(",");
    activeByKey.set(key, g.id);
  }

  // Partition new groups into those that match an existing group and those
  // that don't.
  const created = [];
  const preserved = new Set<string>();
  const groupsToCreate: string[][] = [];

  for (const memberNetIds of groupsOfNetIds) {
    const key = [...memberNetIds].sort().join(",");
    const existingId = activeByKey.get(key);
    if (existingId) {
      preserved.add(existingId);
    } else {
      groupsToCreate.push(memberNetIds);
    }
  }

  // Archive only the groups that are NOT being preserved (their membership
  // changed or they were dropped entirely).
  const toArchive = activeGroups.filter((g) => !preserved.has(g.id));
  if (toArchive.length > 0) {
    await tx.partnerGroup.updateMany({
      where: { id: { in: toArchive.map((g) => g.id) } },
      data: { archivedAt: now, archivedBy: actorNetId },
    });
  }

  // Create the new groups (only the ones that don't match an existing group)
  for (const memberNetIds of groupsToCreate) {
    created.push(
      await tx.partnerGroup.create({
        data: {
          courseId,
          labSection,
          roundNumber,
          createdBy: actorNetId,
          members: {
            create: memberNetIds.map((netId) => ({
              courseId,
              netId,
              roundNumber,
            })),
          },
        },
        include: memberInclude,
      }),
    );
  }

  // Return preserved groups (with refreshed member includes) plus newly created
  // groups, so the caller sees the full set of active groups.
  const preservedFull = await tx.partnerGroup.findMany({
    where: { id: { in: [...preserved] } },
    include: memberInclude,
  });

  return [...preservedFull, ...created];
}

/**
 * Pairs of students (as pairKey strings) who were grouped together in this
 * course+section in an EARLIER round (roundNumber < roundNumber), including
 * archived groups. Feeds generateRandomGroups so generation avoids repeat
 * partnerships. The current round's own groups (active or archived) are
 * deliberately excluded.
 */
export async function getPreviousPartnerPairs({
  tx,
  courseId,
  labSection,
  roundNumber,
}: {
  tx: Tx;
  courseId: string;
  labSection: string;
  roundNumber: number;
}): Promise<Set<string>> {
  const memberships = await tx.partnerGroupMember.findMany({
    where: {
      courseId,
      roundNumber: { lt: roundNumber },
      PartnerGroup: { labSection },
    },
    select: { netId: true, partnerGroupId: true },
  });
  const membersByGroup = new Map<string, string[]>();
  for (const m of memberships) {
    const list = membersByGroup.get(m.partnerGroupId) ?? [];
    list.push(m.netId);
    membersByGroup.set(m.partnerGroupId, list);
  }
  const pairs = new Set<string>();
  for (const members of membersByGroup.values()) {
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        pairs.add(pairKey(members[i], members[j]));
      }
    }
  }
  return pairs;
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
