import { z } from "zod";
import { JobStatus } from "../generated/prisma/enums.js";

export const subscribePayload = z.object({
  jobs: z.array(z.string().min(1)),
});

export const jobResponse = z.object({
  id: z.string().min(1),
  status: z.nativeEnum(JobStatus),
});
