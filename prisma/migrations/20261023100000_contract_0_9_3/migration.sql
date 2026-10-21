-- v0.9.3: the book library and the book a class uses per subject.
ALTER TABLE "Class" ADD COLUMN "books" JSONB NOT NULL DEFAULT '{}';

CREATE TABLE "Book" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "grade" INTEGER NOT NULL,
    "lang" TEXT NOT NULL,
    "part" INTEGER,
    "authors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "publisher" TEXT NOT NULL DEFAULT '',
    "year" INTEGER,
    "summary" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "progressDone" INTEGER NOT NULL DEFAULT 0,
    "progressTotal" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "pageCount" INTEGER NOT NULL,
    "fileName" TEXT NOT NULL,
    "coverKey" TEXT,
    "contents" JSONB,
    "usage" JSONB NOT NULL DEFAULT '{}',
    "leaseUntil" TIMESTAMPTZ(3),
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "publishedAt" TIMESTAMPTZ(3),
    CONSTRAINT "Book_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Book_status_idx" ON "Book"("status");
CREATE INDEX "Book_grade_subjectKey_lang_idx" ON "Book"("grade", "subjectKey", "lang");

CREATE TABLE "BookPage" (
    "bookId" UUID NOT NULL,
    "n" INTEGER NOT NULL,
    "imageKey" TEXT,
    "text" TEXT,
    "read" JSONB,
    CONSTRAINT "BookPage_pkey" PRIMARY KEY ("bookId","n")
);
ALTER TABLE "BookPage" ADD CONSTRAINT "BookPage_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "BookSection" (
    "id" UUID NOT NULL,
    "bookId" UUID NOT NULL,
    "order" INTEGER NOT NULL,
    "chapterNumber" TEXT NOT NULL,
    "chapterTitle" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "pageFrom" INTEGER,
    "pageTo" INTEGER,
    "info" JSONB,
    "topicKey" TEXT,
    "reviewed" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "BookSection_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "BookSection_bookId_order_idx" ON "BookSection"("bookId", "order");
ALTER TABLE "BookSection" ADD CONSTRAINT "BookSection_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;
