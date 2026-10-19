-- Contract 0.6.0: teachers register themselves.
-- User.signup: pending registration details until the e-mail code is confirmed.
ALTER TABLE "User" ADD COLUMN "signup" JSONB;

-- AuthToken.attempts: wrong tries against a 6-digit e-mail code (5 burn it).
ALTER TABLE "AuthToken" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "AuthToken_userId_purpose_idx" ON "AuthToken"("userId", "purpose");

-- School.origin: admin (created by staff) | self (a self-registered teacher's personal school).
ALTER TABLE "School" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'admin';

-- Class.subjectKey: the subject taught in the class.
ALTER TABLE "Class" ADD COLUMN "subjectKey" TEXT;
