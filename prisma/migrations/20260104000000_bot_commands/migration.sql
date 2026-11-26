-- CreateTable
CREATE TABLE "BotCommand" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "sessionId" TEXT,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "result" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "BotCommand_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BotCommand_botId_status_idx" ON "BotCommand"("botId", "status");

-- AddForeignKey
ALTER TABLE "BotCommand" ADD CONSTRAINT "BotCommand_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

