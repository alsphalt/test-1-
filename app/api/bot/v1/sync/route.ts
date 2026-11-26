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
      pairingCode: item.pairingCode ? item.pairingCode.slice(0, 16) : "",
      pairingExpiresAt: item.pairingCode ? new Date(Date.now() + 60_000) : null,
      meNumber: digits(item.meNumber),
      meJid: (item.meJid || "").slice(0, 140),
      platform: (item.platform || "").slice(0, 40),
      connectedAt,
      lastSeenAt: now,
      pairError: "",
    };

    await prisma.whatsAppSession.upsert({
      where: { botId_externalId: { botId: bot.id, externalId } },
      update: data,
      create: data,
    });
  }

  // Anything the bot no longer reports is gone on the bot side.
  const removed = await prisma.whatsAppSession.deleteMany({
    where: { botId: bot.id, source: "BOT", externalId: { notIn: seen.length ? seen : ["__none__"] } },
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
