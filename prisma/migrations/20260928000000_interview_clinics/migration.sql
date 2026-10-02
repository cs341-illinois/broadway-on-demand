-- CreateEnum
CREATE TYPE "ClinicCalendarStatus" AS ENUM ('PENDING', 'CREATED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "InterviewClinic" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "projectKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "signupOpensAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "InterviewClinic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClinicRoomBlock" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "room" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClinicRoomBlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClinicSlot" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "roomBlockId" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "caNetId" TEXT,
    "claimedAt" TIMESTAMP(3),

    CONSTRAINT "ClinicSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClinicBooking" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "slotId" TEXT NOT NULL,
    "projectKey" TEXT NOT NULL,
    "repoName" TEXT NOT NULL,
    "attendeeNetIds" TEXT[],
    "bookedBy" TEXT NOT NULL,
    "bookedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),
    "cancelledBy" TEXT,
    "outlookEventId" TEXT,
    "organizerNetId" TEXT,
    "calendarStatus" "ClinicCalendarStatus" NOT NULL DEFAULT 'PENDING',
    "calendarError" TEXT,

    CONSTRAINT "ClinicBooking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutlookCalendarGrant" (
    "netId" TEXT NOT NULL,
    "encryptedRefreshToken" TEXT NOT NULL,
    "scopes" TEXT NOT NULL,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastError" TEXT,

    CONSTRAINT "OutlookCalendarGrant_pkey" PRIMARY KEY ("netId")
);

-- CreateIndex
CREATE INDEX "InterviewClinic_courseId_archivedAt_idx" ON "InterviewClinic"("courseId", "archivedAt");

-- CreateIndex
CREATE INDEX "ClinicRoomBlock_clinicId_idx" ON "ClinicRoomBlock"("clinicId");

-- CreateIndex
CREATE INDEX "ClinicSlot_clinicId_startAt_idx" ON "ClinicSlot"("clinicId", "startAt");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicSlot_roomBlockId_startAt_key" ON "ClinicSlot"("roomBlockId", "startAt");

-- CreateIndex
CREATE INDEX "ClinicBooking_clinicId_repoName_idx" ON "ClinicBooking"("clinicId", "repoName");

-- CreateIndex
CREATE INDEX "ClinicBooking_slotId_idx" ON "ClinicBooking"("slotId");

-- Partial unique indexes (not expressible in schema.prisma): at most one
-- active booking per slot, and at most one active booking per team per clinic.
CREATE UNIQUE INDEX "ClinicBooking_active_slot_key" ON "ClinicBooking"("slotId") WHERE "cancelledAt" IS NULL;
CREATE UNIQUE INDEX "ClinicBooking_active_team_key" ON "ClinicBooking"("clinicId", "repoName") WHERE "cancelledAt" IS NULL;

-- AddForeignKey
ALTER TABLE "InterviewClinic" ADD CONSTRAINT "InterviewClinic_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicRoomBlock" ADD CONSTRAINT "ClinicRoomBlock_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "InterviewClinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicSlot" ADD CONSTRAINT "ClinicSlot_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "InterviewClinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicSlot" ADD CONSTRAINT "ClinicSlot_roomBlockId_fkey" FOREIGN KEY ("roomBlockId") REFERENCES "ClinicRoomBlock"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicBooking" ADD CONSTRAINT "ClinicBooking_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "InterviewClinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicBooking" ADD CONSTRAINT "ClinicBooking_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "ClinicSlot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
