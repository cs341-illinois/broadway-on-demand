import { Role } from "../generated/prisma/client.js";
import { EnumLike, z } from "zod";

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

export type HumanReadableEnum<T extends EnumLike, U = string> = {
  [K in keyof T as T[K]]: U;
};

export type EnumMapper<T extends EnumLike, U extends any> = {
  [K in keyof T as T[K]]: U;
};

export const courseDateString = z
  .string()
  .transform((date) => {
    const utc = new Date(date);
    utc.setUTCSeconds(utc.getSeconds(), 0);
    return utc.toISOString();
  })
  .pipe(z.string());

export const netIdSchema = z.string().min(3).max(8);
export const uinSchema = z
  .string()
  .regex(/^\d{9}$/, "UIN must be exactly 9 digits.");
