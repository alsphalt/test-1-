-- Outbound WhatsApp queue for messages the web app must send through the worker
-- (for example a personal Setup code). Additive only.

CREATE TABLE "WhatsAppOutbox" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "WhatsAppOutbox_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WhatsAppOutbox_status_createdAt_idx" ON "WhatsAppOutbox"("status", "createdAt");
CREATE INDEX "WhatsAppOutbox_sessionId_idx" ON "WhatsAppOutbox"("sessionId");
