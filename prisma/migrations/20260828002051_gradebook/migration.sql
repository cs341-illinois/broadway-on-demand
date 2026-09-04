-- AlterEnum
ALTER TYPE "Category" ADD VALUE 'PRAIRIELEARN';

-- AlterTable
ALTER TABLE "Assignment" ADD COLUMN     "prairieLearnAssessmentId" TEXT,
ADD COLUMN     "weight" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Course" ADD COLUMN     "prairieLearnApiToken" TEXT,
ADD COLUMN     "prairieLearnBaseUrl" TEXT,
ADD COLUMN     "prairieLearnCourseInstanceId" TEXT,
ADD COLUMN     "prairieLearnLastSyncedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "GradingCategoryConfig" (
    "courseId" TEXT NOT NULL,
    "category" "Category" NOT NULL,
    "dropLowest" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "GradingCategoryConfig_pkey" PRIMARY KEY ("courseId","category")
);

-- CreateIndex
CREATE UNIQUE INDEX "Assignment_courseId_prairieLearnAssessmentId_key" ON "Assignment"("courseId", "prairieLearnAssessmentId");

-- AddForeignKey
ALTER TABLE "GradingCategoryConfig" ADD CONSTRAINT "GradingCategoryConfig_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

