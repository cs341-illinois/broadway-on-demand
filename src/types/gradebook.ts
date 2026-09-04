import { z } from "zod";
import { Category } from "../generated/prisma/enums.js";

// ---------------------------------------------------------------------------
// grading.config.yaml schema (consumed by src/scripts/applyGradingConfig.ts)
// ---------------------------------------------------------------------------

export const gradingConfigYamlSchema = z.object({
  courseId: z.string().min(1),
  // .nullish() (not just .optional()) because a YAML key left with only
  // comments under it (no value) parses to `null`, not `undefined`.
  prairieLearn: z
    .object({
      baseUrl: z.string().url(),
      courseInstanceId: z.string().min(1),
      apiToken: z.string().min(1),
    })
    .nullish(),
  categories: z.record(z.nativeEnum(Category), z.object({
    dropLowest: z.number().int().min(0).default(0),
  })).nullish(),
  assignmentWeights: z.record(z.string().min(1), z.number().min(0)).nullish(),
});

export type GradingConfigYaml = z.infer<typeof gradingConfigYamlSchema>;

// ---------------------------------------------------------------------------
// Gradebook API contract (GET /api/v1/gradebook/:courseId)
// ---------------------------------------------------------------------------

export const gradebookAssignmentEntry = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  category: z.nativeEnum(Category),
  weight: z.number().min(0),
  // No upper bound: PrairieLearn assessments can award bonus points, so
  // score_perc (and therefore this) can legitimately exceed 100.
  score: z.number().min(0).nullable(),
  comments: z.string().nullable(),
});

export type GradebookAssignmentEntry = z.infer<typeof gradebookAssignmentEntry>;

export const categoryConfigEntry = z.object({
  category: z.nativeEnum(Category),
  dropLowest: z.number().int().min(0),
});

export type CategoryConfigEntry = z.infer<typeof categoryConfigEntry>;

export const gradebookResponse = z.object({
  assignments: z.array(gradebookAssignmentEntry),
  categoryConfigs: z.array(categoryConfigEntry),
  // No upper bound, for the same reason as gradebookAssignmentEntry.score.
  currentGrade: z.number().min(0).nullable(),
});

export type GradebookResponse = z.infer<typeof gradebookResponse>;

// ---------------------------------------------------------------------------
// calculateFinalGrade — pure, dependency-free (safe to import from client code)
//
// Implements weight-per-assignment with per-category "drop lowest N",
// redistributing a dropped assignment's weight proportionally among the
// remaining graded, non-zero-weight assignments in its category so the
// category's total weight contribution is preserved. See the "Grade
// calculation" section of the unified gradebook plan for the full spec.
// ---------------------------------------------------------------------------

export interface GradeCalcAssignmentInput {
  id: string;
  category: Category;
  weight: number;
  score: number | null;
}

export interface GradeCalcCategoryConfig {
  category: Category;
  dropLowest: number;
}

export interface CategoryBreakdownEntry {
  category: Category;
  earnedWeight: number;
  totalWeight: number;
  droppedAssignmentIds: string[];
}

export interface FinalGradeResult {
  finalGrade: number | null;
  categoryBreakdown: CategoryBreakdownEntry[];
}

export function calculateFinalGrade(
  assignments: GradeCalcAssignmentInput[],
  categoryConfigs: GradeCalcCategoryConfig[],
): FinalGradeResult {
  const dropLowestByCategory = new Map<Category, number>(
    categoryConfigs.map((c) => [c.category, c.dropLowest]),
  );

  const assignmentsByCategory = new Map<Category, GradeCalcAssignmentInput[]>();
  for (const a of assignments) {
    const list = assignmentsByCategory.get(a.category) ?? [];
    list.push(a);
    assignmentsByCategory.set(a.category, list);
  }

  let numerator = 0;
  let denominator = 0;
  const categoryBreakdown: CategoryBreakdownEntry[] = [];

  for (const [category, categoryAssignments] of assignmentsByCategory) {
    const dropLowest = dropLowestByCategory.get(category) ?? 0;

    const candidates = categoryAssignments.filter(
      (a) => a.score !== null && a.weight > 0,
    );
    const effectiveDrop = Math.min(dropLowest, Math.max(candidates.length - 1, 0));

    const sortedCandidates = [...candidates].sort((a, b) => {
      if (a.score !== b.score) return (a.score as number) - (b.score as number);
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    const dropped = new Set(sortedCandidates.slice(0, effectiveDrop).map((a) => a.id));

    const originalCandidateWeight = candidates.reduce((sum, a) => sum + a.weight, 0);
    const remainingCandidateWeight = candidates
      .filter((a) => !dropped.has(a.id))
      .reduce((sum, a) => sum + a.weight, 0);
    const scaleFactor =
      remainingCandidateWeight > 0 ? originalCandidateWeight / remainingCandidateWeight : 0;

    let earnedWeight = 0;
    let totalWeight = 0;
    for (const a of categoryAssignments) {
      if (dropped.has(a.id)) continue;
      if (a.score === null) continue;

      const isCandidate = a.weight > 0;
      const effectiveWeight = isCandidate ? a.weight * scaleFactor : a.weight;

      numerator += effectiveWeight * a.score;
      denominator += effectiveWeight;
      earnedWeight += effectiveWeight * (a.score / 100);
      totalWeight += effectiveWeight;
    }

    categoryBreakdown.push({
      category,
      earnedWeight,
      totalWeight,
      droppedAssignmentIds: [...dropped],
    });
  }

  return {
    // numerator/denominator are both already in "score (0-100) * weight"
    // units, so their ratio is already a 0-100 percentage — no extra *100.
    finalGrade: denominator === 0 ? null : numerator / denominator,
    categoryBreakdown,
  };
}
