import { prisma } from "@/lib/db";
import { publish } from "@/lib/events";
import { assertSameOrigin, clientIp, json, rateLimit, readJson, route } from "@/lib/http";
import { requireBot, digits, normalizeStatus } from "@/lib/botAgent";
import { botSyncSchema } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Authoritative snapshot push from a bot agent.
 *
 * The bot owns its sockets; this endpoint makes the website's copy match it:
 * upsert every reported session, delete the ones the bot no longer has, and
 * refresh the bot's own heartbeat in the same transaction.
 */
export const POST = route(async (req: Request) => {
  assertSameOrigin(req);
  const bot = await requireBot(req);
  rateLimit(`bot:sync:${bot.id}`, 240, 60_000);

  const input = botSyncSchema.parse(await readJson<unknown>(req));
  const now = new Date();
  const ip = clientIp(req);
  const seen: string[] = [];

  for (const item of input.sessions) {
    const externalId = item.externalId.slice(0, 120);
    seen.push(externalId);

    const status = normalizeStatus(item.status);
    const phone = digits(item.phone || item.meNumber);
    const connectedAt =
      status === "CONNECTED"
        ? item.connectedAt
          ? new Date(item.connectedAt)
          : now
        : null;

    const data = {
      userId: bot.userId,
      botId: bot.id,
      source: "BOT",
      externalId,
      label: (item.label || `+${phone || "number"}`).slice(0, 60),
      phone,
      status,
      statusDetail: (item.statusDetail || "").slice(0, 300),
      // Only touch the code when the bot actually mentions one: a routine sync
      // must not wipe a code the owner is still typing into their phone.
      ...(item.pairingCode
        ? { pairingCode: item.pairingCode.slice(0, 16), pairingExpiresAt: new Date(Date.now() + 60_000) }
        : status === "CONNECTED"
          ? { pairingCode: "", pairingExpiresAt: null }
          : {}),
      meNumber: digits(item.meNumber),
      meJid: (item.meJid || "").slice(0, 140),
      platform: (item.platform || "").slice(0, 40),
      connectedAt,
      lastSeenAt: now,
      pairError: "",
    };

    /*
     * Adopt the row the owner created in the panel.
     *
     * A pairing request starts life as a panel row with a `req_…` placeholder
     * id. If the bot names the row it paired from, that row becomes the synced
     * session: one number, one row, and the panel keeps the label the owner
     * chose instead of gaining a duplicate.
     */
    const adopted =
      (item.requestId
        ? await prisma.whatsAppSession.findFirst({
            where: { id: item.requestId, botId: bot.id },
            select: { id: true, status: true },
          })
        : null) ||
      // The very first sync happens before the bot has picked the request up,
      // so it has no requestId to quote. The number itself identifies the row:
      // one bot cannot legitimately have two pending rows for one number.
      (phone
        ? await prisma.whatsAppSession.findFirst({
            where: { botId: bot.id, phone, status: "PAIRING_REQUESTED" },
            orderBy: { createdAt: "desc" },
            select: { id: true, status: true },
          })
        : null);

    /*
     * A pending request must stay visible until the bot actually issues a
     * code. The bot's first sync already reports "PAIRING" for the number it
     * is about to pair, and copying that over PAIRING_REQUESTED would hide the
     * request from the pairing feed in the same response.
     */
    if (adopted?.status === "PAIRING_REQUESTED" && !item.pairingCode && (status === "PAIRING_CODE" || status === "CONNECTING")) {
      delete (data as Record<string, unknown>).status;
      delete (data as Record<string, unknown>).statusDetail;
    }

    const holder = await prisma.whatsAppSession.findUnique({
      where: { botId_externalId: { botId: bot.id, externalId } },
      select: { id: true },
    });

    if (adopted && (!holder || holder.id === adopted.id)) {
      await prisma.whatsAppSession.update({ where: { id: adopted.id }, data });
    } else {
      // A previous row already owns this bot-side id; release it so the
      // upsert cannot fail, and let the cleanup below remove it.
      if (adopted && holder && holder.id !== adopted.id) {
        await prisma.whatsAppSession.update({
          where: { id: holder.id },
          data: { externalId: `stale_${holder.id}` },
        });
      }
      await prisma.whatsAppSession.upsert({
        where: { botId_externalId: { botId: bot.id, externalId } },
        update: data,
        create: data,
      });
    }
  }

  /*
   * Anything the bot no longer reports is gone on the bot side — except a
   * pairing request the owner just made, which the bot may not have picked up
   * yet. Deleting those would make "pair from the panel" fail on the first
   * sync.
   */
  const removed = await prisma.whatsAppSession.deleteMany({
    where: {
      botId: bot.id,
      source: "BOT",
      externalId: { notIn: seen.length ? seen : ["__none__"] },
      // Live work must survive a snapshot that has not caught up yet: queued or
      // armed codes, plus anything the owner started in the last 15 minutes.
      // A transient DISCONNECTED while the pairing socket settles must not wipe
      // the code the owner is typing.
      status: { notIn: ["PAIRING_REQUESTED", "PAIRING_CODE", "RECONNECT_REQUESTED"] },
      NOT: {
        OR: [
          { pairingExpiresAt: { gt: new Date() } },
          { pairRequestedAt: { gt: new Date(Date.now() - 15 * 60_000) } },
        ],
      },
    },
  });

  await prisma.$transaction([
    prisma.bot.update({
      where: { id: bot.id },
      data: {
        status: input.status,
        lastSeenAt: now,
        ...(input.version ? { version: input.version.slice(0, 40) } : {}),
        ...(input.messagesSent !== undefined ? { messagesSent: input.messagesSent } : {}),
        ...(input.errors !== undefined ? { errors: input.errors } : {}),
      },
    }),
    prisma.botLog.create({
      data: {
        botId: bot.id,
        level: input.status === "ERROR" ? "ERROR" : "INFO",
        message: (input.message || `sync: ${input.sessions.length} session(s)`).slice(0, 500),
        meta: JSON.stringify({ ip, removed: removed.count, version: input.version || "" }),
      },
    }),
  ]);

  publish(bot.userId, "bot.updated", { id: bot.id, status: input.status, synced: input.sessions.length });
  publish(bot.userId, "whatsapp.updated", { botId: bot.id, synced: input.sessions.length });

  const pending = await prisma.whatsAppSession.findMany({
    where: { botId: bot.id, status: "PAIRING_REQUESTED" },
    orderBy: { pairRequestedAt: "asc" },
    select: { id: true, phone: true, label: true, pairRequestedAt: true },
  });

  return json({
    ok: true,
    serverTime: now.toISOString(),
    synced: input.sessions.length,
    removed: removed.count,
    pairingRequests: pending.map((p) => ({
      id: p.id,
      phone: p.phone,
      label: p.label,
      requestedAt: p.pairRequestedAt?.toISOString() || null,
    })),
  });
});
