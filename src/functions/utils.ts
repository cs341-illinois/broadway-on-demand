interface RetryOptions {
  retries?: number;
  delayMs?: number;
  exponentialBackoff?: boolean;
  maxDelayMs?: number;
  onError?: (error: any, attempt: number) => Promise<void> | void;
}

export async function retryAsync<T>(
  asyncFn: (...args: any[]) => Promise<T>,
  options: RetryOptions = {},
  ...args: any[]
): Promise<T> {
  const {
    retries = 10,
    delayMs = 500,
    exponentialBackoff = true,
    maxDelayMs = 10000,
    onError,
  } = options;

  let attempt = 0;
  let lastError: any;

  while (attempt < retries) {
    attempt++;
    try {
      const result = await asyncFn(...args);
      return result;
    } catch (error) {
      lastError = error;
      console.error(`Attempt ${attempt} failed:`, error);
      if (onError) {
        await onError(error, attempt);
      }

      if (attempt < retries) {
        let sleepTime = delayMs;
        if (exponentialBackoff) {
          const sign = Math.random() <= 0.5 ? -1 : 1;
          const currentStaticSleep = delayMs * 2 ** (attempt - 1);
          sleepTime = Math.min(
            currentStaticSleep +
              sign * Math.random() * 0.5 * currentStaticSleep,
            maxDelayMs,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, sleepTime));
      }
    }
  }
  throw lastError;
}

export interface CourseIdParts {
  department: string;
  courseNumber: string;
  semesterCode: string;
  yearCode: string;
}

export function splitCourseIdString(courseId: string): CourseIdParts | null {
  const regex = /^([a-zA-Z]+)([0-9]+)[^a-zA-Z0-9]*([a-zA-Z]+)([0-9]+)$/;
  const match = courseId.toLowerCase().match(regex);

  if (match && match.length === 5) {
    return {
      department: match[1],
      courseNumber: match[2],
      semesterCode: match[3],
      yearCode: match[4],
    };
  }
  return null;
}

export const isValidTimeZone = (tz: string): boolean => {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch (e) {
    return false;
  }
};

export function capitalizeFirstLetterOnly(val: string): string {
  return val.charAt(0).toUpperCase() + val.slice(1).toLowerCase();
}
