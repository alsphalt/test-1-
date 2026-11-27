-- Pending panel sessions stored the empty string as their bot-side id.
--
-- Two consequences:
--   * the (botId, externalId) unique index allowed a bot only ONE pending
--     pairing request at a time, and the second create failed with P2002;
--   * the first sync from the bot deleted the pending row (it was not in the
--     reported set), so "pair from the panel" could never complete.
--
-- New rows get a `req_<uuid>` placeholder from the API. This backfills the
-- rows that already exist. Idempotent: a second run matches nothing, and the
-- statement never deletes or overwrites a real bot-side id.
UPDATE "WhatsAppSession"
SET "externalId" = 'req_' || "id"
WHERE "externalId" = '' AND "botId" IS NOT NULL;
