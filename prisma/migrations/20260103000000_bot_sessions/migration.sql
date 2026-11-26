-- AlterTable
ALTER TABLE "WhatsAppSession" ADD COLUMN     "botId" TEXT,
ADD COLUMN     "externalId" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "pairError" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "pairRequestedAt" TIMESTAMP(3),
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'WORKER';

-- CreateIndex
CREATE INDEX "WhatsAppSession_botId_idx" ON "WhatsAppSession"("botId");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppSession_botId_externalId_key" ON "WhatsAppSession"("botId", "externalId");

-- AddForeignKey
ALTER TABLE "WhatsAppSession" ADD CONSTRAINT "WhatsAppSession_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

