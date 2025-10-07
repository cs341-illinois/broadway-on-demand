import { z } from "zod";

export const StatsResponseSchema = z.object({
  meanScore: z.number(),
  medianScore: z.number(),
  standardDeviation: z.number(),
  totalScores: z.number(),
  scores: z.array(z.number()),
});

export type StatsResponse = z.infer<typeof StatsResponseSchema>;
