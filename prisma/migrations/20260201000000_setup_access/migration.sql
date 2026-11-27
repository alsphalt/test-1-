-- Darknote Setup: owner-controlled Setup accounts, personal setup codes and access requests.
-- Additive only: no existing table is dropped or rewritten.

CREATE TABLE "SetupAccount" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "phone" TEXT NOT NULL DEFAULT '',
    "displayName" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'INVITED',
    "setupCodeHash" TEXT NOT NULL,
    "setupCodePrefix" TEXT NOT NULL DEFAULT '',
    "setupCodeIssuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "setupCodeExpiresAt" TIMESTAMP(3) NOT NULL,
    "setupCodeUsedAt" TIMESTAMP(3),
    "codeDelivery" TEXT NOT NULL DEFAULT 'NOT_SENT',
    "codeDeliveryNote" TEXT NOT NULL DEFAULT '',
    "userId" TEXT,
    "createdById" TEXT,
    "activatedAt" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SetupAccount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SetupAccount_username_key" ON "SetupAccount"("username");
CREATE INDEX "SetupAccount_status_idx" ON "SetupAccount"("status");
CREATE INDEX "SetupAccount_userId_idx" ON "SetupAccount"("userId");

CREATE TABLE "SetupAccessRequest" (
    "id" TEXT NOT NULL,
    "setupAccountId" TEXT NOT NULL,
    "userId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "note" TEXT NOT NULL DEFAULT '',
    "decidedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "SetupAccessRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SetupAccessRequest_status_createdAt_idx" ON "SetupAccessRequest"("status", "createdAt");
CREATE INDEX "SetupAccessRequest_setupAccountId_idx" ON "SetupAccessRequest"("setupAccountId");

CREATE TABLE "SetupSession" (
    "id" TEXT NOT NULL,
    "setupAccountId" TEXT,
    "ownerUserId" TEXT,
    "role" TEXT NOT NULL DEFAULT 'USER',
    "tokenHash" TEXT NOT NULL,
    "ip" TEXT NOT NULL DEFAULT '',
    "userAgent" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "SetupSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SetupSession_tokenHash_key" ON "SetupSession"("tokenHash");
CREATE INDEX "SetupSession_setupAccountId_idx" ON "SetupSession"("setupAccountId");
CREATE INDEX "SetupSession_ownerUserId_idx" ON "SetupSession"("ownerUserId");
CREATE INDEX "SetupSession_expiresAt_idx" ON "SetupSession"("expiresAt");

CREATE TABLE "OwnerCredential" (
    "id" TEXT NOT NULL DEFAULT 'owner',
    "tokenHash" TEXT NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OwnerCredential_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "SetupAccessRequest" ADD CONSTRAINT "SetupAccessRequest_setupAccountId_fkey"
    FOREIGN KEY ("setupAccountId") REFERENCES "SetupAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SetupSession" ADD CONSTRAINT "SetupSession_setupAccountId_fkey"
    FOREIGN KEY ("setupAccountId") REFERENCES "SetupAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
