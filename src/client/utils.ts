import { FullRoleEntry, User } from "../types/index";

export const formulateUrl = (uri: string) => {
  return `${import.meta.env.BASE_URL}/${uri}`.replaceAll("//", "/");
};

export function getCourseRoles(course: string, roles: FullRoleEntry[]) {
  return roles.filter((x) => x.courseId === course).map((x) => x.role);
}

export const formatDateForDateTimeLocalInput = (date: Date) => {
  if (!date) return "";

  // Prevent issues if date is invalid
  if (isNaN(date.getTime())) return "";

  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
};

export function addDays(date: Date, days: number) {
  var result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

export function setEndOfDay(date: Date): Date {
  const endOfDay = new Date(date.getTime());
  endOfDay.setHours(23, 59, 0, 0);

  return endOfDay;
}

export const dateTimeFormatString = "MM/DD/YYYY hh:mm:ss A";

export type ResourceStatus = "pending" | "success" | "error";

export interface Resource<T> {
  read: () => T;
}

export function createResource<T>(promiseFn: () => Promise<T>): Resource<T> {
  let status: ResourceStatus = "pending";
  let result: T | Error;

  const suspender = promiseFn()
    .then((r: T) => {
      status = "success";
      result = r;
    })
    .catch((e: unknown) => {
      status = "error";
      if (e instanceof Error) {
        result = e;
      } else {
        result = new Error(
          String(e || "An unknown error occurred during resource fetching"),
        );
      }
    });

  return {
    read(): T {
      if (status === "pending") {
        throw suspender;
      } else if (status === "error") {
        throw result;
      } else if (status === "success") {
        return result as T;
      }
      throw new Error("Invalid resource state");
    },
  };
}

export function capitalizeFirstLetterOnly(val: string): string {
  return val.charAt(0).toUpperCase() + val.slice(1).toLowerCase();
}

export function attemptFormatEnum(value: string) {
  const items = value
    .split("_")
    .map((x, idx) =>
      idx === 0 ? capitalizeFirstLetterOnly(x) : x.toLowerCase(),
    );
  return items.join(" ");
}

export const setCourseInfoSessionStorage = (entry: FullRoleEntry) => {
  window.sessionStorage.setItem("courseInfo", JSON.stringify(entry));
};

export function getCourseInfo(user: User, courseId: string) {
  const courseInfo = user.roles.filter((x) => x.courseId === courseId);
  const data = courseInfo.length === 0 ? null : courseInfo[0];
  if (data) {
    setCourseInfoSessionStorage(data);
  }
  return data;
}

export function roundToNextMinute(date: Date) {
  // Create a new date object to avoid modifying the original one
  const roundedDate = new Date(date);

  // Check if the seconds are greater than 0, if so, round up
  if (roundedDate.getSeconds() > 0 || roundedDate.getMilliseconds() > 0) {
    // Add one minute
    roundedDate.setMinutes(roundedDate.getMinutes() + 1);
  }

  // Set seconds and milliseconds to 0
  roundedDate.setSeconds(0);
  roundedDate.setMilliseconds(0);

  return roundedDate;
}

export function downloadText(filename: string, text: string) {
  var element = document.createElement("a");
  element.setAttribute(
    "href",
    "data:text/plain;charset=utf-8," + encodeURIComponent(text),
  );
  element.setAttribute("download", filename);

  element.style.display = "none";
  document.body.appendChild(element);

  element.click();

  document.body.removeChild(element);
}

export function getTimeZoneName() {
  const now = new Date();
  const timeZoneFormatter = new Intl.DateTimeFormat("en-US", {
    timeZoneName: "long",
  });
  const parts = timeZoneFormatter.formatToParts(now);
  if (!parts) {
    throw new Error("Failed to get user time zone.");
  }
  const timeZonePart = parts.find((part) => part.type === "timeZoneName");

  if (!timeZonePart) {
    throw new Error("Could not find time zone name part.");
  }

  return timeZonePart.value;
}

export async function getSafeErrorResponse(
  response: Response,
  defaultErrorMessage?: string,
) {
  let errorResponse;
  try {
    errorResponse = (await response.json()) as { message: string };
  } catch (e) {
    errorResponse = {
      message: defaultErrorMessage || "An unknown error occurred.",
    };
  }
  return errorResponse;
}
