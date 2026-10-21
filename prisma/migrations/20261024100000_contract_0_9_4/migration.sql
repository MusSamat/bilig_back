-- v0.9.4: the kind of a library book (a teacher's guide is not offered as a class book).
ALTER TABLE "Book" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'textbook';
