-- Contract 0.7.0: phone-first teacher accounts.
-- User.phone: the teacher's WhatsApp number (E.164), unique; phoneVerifiedAt: when a code proved it.
ALTER TABLE "User" ADD COLUMN "phone" TEXT;
ALTER TABLE "User" ADD COLUMN "phoneVerifiedAt" TIMESTAMPTZ(3);
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");

-- PhoneOtp: one-time codes sent to a number (kind = code) and the short-lived
-- tokens a verified code is exchanged for (kind = token). No user yet on registration.
CREATE TABLE "PhoneOtp" (
    "id" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),

    CONSTRAINT "PhoneOtp_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PhoneOtp_hash_key" ON "PhoneOtp"("hash");
CREATE INDEX "PhoneOtp_phone_purpose_kind_idx" ON "PhoneOtp"("phone", "purpose", "kind");
