-- v0.9.1: generated examples / practice questions a user already got.
CREATE TABLE "GeneratedSeen" (
    "userId" UUID NOT NULL,
    "generatedId" UUID NOT NULL,
    "seenAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "GeneratedSeen_pkey" PRIMARY KEY ("userId","generatedId")
);

CREATE INDEX "GeneratedSeen_userId_seenAt_idx" ON "GeneratedSeen"("userId", "seenAt");

ALTER TABLE "GeneratedSeen" ADD CONSTRAINT "GeneratedSeen_generatedId_fkey" FOREIGN KEY ("generatedId") REFERENCES "GeneratedContent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- v0.9.1: prompt-cache hits of every tutor call (cost = misses at the full price + hits at the cache price).
ALTER TABLE "TutorMessage" ADD COLUMN "cachedTokens" INTEGER NOT NULL DEFAULT 0;

-- v0.9.1: shared answers to self-contained questions (no model call for a repeat).
CREATE TABLE "TutorAnswer" (
    "key" TEXT NOT NULL,
    "topicKey" TEXT NOT NULL,
    "lang" TEXT NOT NULL,
    "raw" TEXT NOT NULL,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TutorAnswer_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "TutorAnswer_topicKey_idx" ON "TutorAnswer"("topicKey");
