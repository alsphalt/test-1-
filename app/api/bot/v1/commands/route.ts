import { prisma } from "@/lib/db";
import { assertSameOrigin, json, rateLimit, route } from "@/lib/http";
import { requireBot } from "@/lib/botAgent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Pending control commands (restart / unlink). Claiming marks the row delivered
 * so two pollers cannot both act on it.
 */
export const GET = route(async (req: Request) => {
  assertSameOrigin(req);
  const bot = await requireBot(req);
  rateLimit(`bot:commands:${bot.id}`, 240, 60_000);

  const rows = await prisma.botCommand.findMany({
    where: { botId: bot.id, status: "PENDING" },
    orderBy: { createdAt: "asc" },
    take: 20,
    select: { id: true, sessionId: true, type: true, createdAt: true },
  });

  if (rows.length) {
    await prisma.botCommand.updateMany({
      where: { id: { in: rows.map((r) => r.id) }, status: "PENDING" },
      data: { deliveredAt: new Date() },
    });
  }

  const sessions = await prisma.whatsAppSession.findMany({
    where: { id: { in: rows.map((r) => r.sessionId).filter(Boolean) as string[] } },
    select: { id: true, externalId: true, phone: true, label: true },
  });
  const byId = new Map(sessions.map((s) => [s.id, s]));

  return json({
    commands: rows.map((r) => ({
      id: r.id,
      type: r.type,
      createdAt: r.createdAt.toISOString(),
      session: r.sessionId ? byId.get(r.sessionId) || null : null,
    })),
  });
});
