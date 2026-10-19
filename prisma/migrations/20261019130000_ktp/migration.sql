-- Contract 0.5.0 §6: КТП → lesson plans. One row per uploaded КТП; `doc` holds
-- the TeachingPlan body (rows, issues, meta) without id/owner/timestamps/version.
-- CreateTable
CREATE TABLE "TeachingPlan" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "doc" JSONB NOT NULL,
    "version" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TeachingPlan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TeachingPlan_ownerId_idx" ON "TeachingPlan"("ownerId");
