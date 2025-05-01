import { FullRoleEntry } from "../types/index";

export const formulateUrl = (uri: string) => {
  return `${import.meta.env.BASE_URL}/${uri}`.replaceAll("//", "/");
};

export function getCourseRoles(course: string, roles: FullRoleEntry[]) {
  return roles.filter((x) => x.courseId === course).map((x) => x.role);
}

export function formatDateForInput(value: Date): string {
  const date = new Date(value).toLocaleString();
  console.log(date)

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');

  return `${year}-${month}-${day}T${hours}:${minutes}`;
}
