import { Role } from "../../generated/prisma";
import { FullRoleEntry } from "../types/index";

export const formulateUrl = (uri: string) => {
  return `${import.meta.env.BASE_URL}/${uri}`.replaceAll("//", "/");
};

export function getCourseRoles(course: string, roles: FullRoleEntry[]) {
  return roles.filter((x) => x.courseId === course).map((x) => x.role);
}
