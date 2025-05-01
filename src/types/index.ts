import { Role } from "@prisma/client";
import { EnumLike } from "zod";

export interface FullRoleEntry {
  courseId: string;
  courseName: string;
  role: Role;
}

export interface User {
  id: string;
  displayName: string;
  email: string;
  givenName: string;
  surname: string;
  roles: FullRoleEntry[];
}

export type HumanReadableEnum<T extends EnumLike> = {
  [K in keyof T as T[K]]: string;
};
