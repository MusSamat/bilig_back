-- v0.10.0: the teacher cabinet v3.

-- The lesson model a teacher's new lessons start with.
ALTER TABLE "User" ADD COLUMN "defaultLessonModel" TEXT;

-- An assignment's own title and the КТП lesson it was given from.
ALTER TABLE "Assignment" ADD COLUMN "title" TEXT;
ALTER TABLE "Assignment" ADD COLUMN "lessonPlanId" UUID;
ALTER TABLE "Assignment" ADD COLUMN "lessonUid" TEXT;

-- The content of a КТП lesson (model stages, goals, materials) and where it was taught.
CREATE TABLE "LessonContent" (
    "id" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "uid" TEXT NOT NULL,
    "doc" JSONB NOT NULL,
    "conducted" JSONB NOT NULL,
    "version" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LessonContent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LessonContent_planId_uid_key" ON "LessonContent"("planId", "uid");
CREATE INDEX "LessonContent_ownerId_idx" ON "LessonContent"("ownerId");
