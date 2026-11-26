import { prisma } from "@/lib/db";
import { assertSameOrigin, json, route } from "@/lib/http";
import { requireBot } from "@/lib/botAgent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Connection test for the bot's settings screen: identity + what is waiting. */
export const GET = route(async (req: Request) => {
  assertSameOrigin(req);
  const bot = await requireBot(req);

  const [sessions, pendingPairing, pendingCommands, last] = await Promise.all([
    prisma.whatsAppSession.count({ where: { botId: bot.id } }),
    prisma.whatsAppSession.count({ where: { botId: bot.id, status: "PAIRING_REQUESTED" } }),
    prisma.botCommand.count({ where: { botId: bot.id, status: "PENDING" } }),
    prisma.bot.findUnique({ where: { id: bot.id }, select: { status: true, version: true, lastSeenAt: true } }),
  ]);

  return json({
    ok: true,
    bot: { id: bot.id, name: bot.name },
    serverTime: new Date().toISOString(),
    sessions,
    pendingPairing,
    pendingCommands,
    lastReport: last?.lastSeenAt?.toISOString() || null,
    version: last?.version || "",
  });
});
