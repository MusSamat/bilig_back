-- Contract 0.4.0: pool of AI-generated examples and practice questions.
CREATE TABLE "GeneratedContent" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "topicKey" TEXT NOT NULL,
    "conceptKey" TEXT,
    "lang" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "signature" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'new',
    "good" INTEGER NOT NULL DEFAULT 0,
    "bad" INTEGER NOT NULL DEFAULT 0,
    "reasons" JSONB NOT NULL DEFAULT '{}',
    "served" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "reviewedAt" TIMESTAMPTZ(3),
    "reviewedBy" UUID,
    "promotedTo" TEXT,

    CONSTRAINT "GeneratedContent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GeneratedContent_topicKey_kind_lang_idx" ON "GeneratedContent"("topicKey", "kind", "lang");
CREATE INDEX "GeneratedContent_status_idx" ON "GeneratedContent"("status");
