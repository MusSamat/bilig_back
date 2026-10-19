-- Contract 0.5.0: textbooks mapped onto topics.
-- CreateTable
CREATE TABLE "Textbook" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "doc" JSONB NOT NULL,
    "subjectKey" TEXT,
    "searchText" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL,
    "grade" INTEGER,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedBy" UUID,

    CONSTRAINT "Textbook_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Textbook_key_key" ON "Textbook"("key");

-- CreateIndex
CREATE INDEX "Textbook_subjectKey_idx" ON "Textbook"("subjectKey");

-- CreateIndex
CREATE INDEX "Textbook_grade_idx" ON "Textbook"("grade");
