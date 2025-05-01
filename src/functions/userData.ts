import { PrismaClient } from "@prisma/client";
import { FullRoleEntry } from "../types/index.js";
const prisma = new PrismaClient();
export async function getUserRolesByNetId(netId: string) {
  const roles = await prisma.users.findMany({
    where: {
      netId,
    },
    select: {
      courseId: true,
      role: true,
      course: {
        select: {
          name: true,
        },
      },
    },
  });
  return roles.map(({ role, courseId, course }) => ({
    role,
    courseId,
    courseName: course?.name || null,
  }));
}

export function getCourseRoles(course: string, roles: FullRoleEntry[]) {
  return roles.filter((x) => x.courseId === course).map((x) => x.role);
}
