-- Contract 0.3.0 (additive): optimistic versions for schools, licences and
-- locale strings; invite revocation; topic updatedBy; review-comment anchors;
-- asset versions (existing assets are backfilled as version 1).

-- AlterTable
ALTER TABLE "Invite" ADD COLUMN     "revokedAt" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "School" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "License" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "Topic" ADD COLUMN     "updatedBy" UUID;

-- AlterTable
ALTER TABLE "Asset" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "LocaleString" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "ReviewComment" ADD COLUMN     "anchor3d" JSONB,
ADD COLUMN     "resolvedBy" UUID,
ADD COLUMN     "topicVersion" TEXT;

-- CreateTable
CREATE TABLE "AssetVersion" (
    "assetId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sizeAfter" INTEGER,
    "triangles" INTEGER,
    "nodes" JSONB NOT NULL,
    "violations" JSONB NOT NULL,
    "originalUrl" TEXT,
    "optimizedUrl" TEXT,
    "thumbUrl" TEXT,
    "uploadId" TEXT NOT NULL,
    "message" TEXT,
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "AssetVersion_pkey" PRIMARY KEY ("assetId","version")
);

-- AddForeignKey
ALTER TABLE "AssetVersion" ADD CONSTRAINT "AssetVersion_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill: every existing asset gets its current file as version 1.
INSERT INTO "AssetVersion" ("assetId", "version", "filename", "contentType", "status", "sizeBytes", "sizeAfter", "triangles", "nodes", "violations", "originalUrl", "optimizedUrl", "thumbUrl", "uploadId", "message", "createdBy", "createdAt", "completedAt")
SELECT "id", 1, "filename", "contentType", "status", "sizeBytes", "sizeAfter", "triangles", "nodes", "violations", "originalUrl", "optimizedUrl", "thumbUrl", "uploadId", NULL, "createdBy", "createdAt", NULL
FROM "Asset";
