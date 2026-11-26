import { prisma } from "@/lib/db";
import { publish } from "@/lib/events";
import { assertSameOrigin, json, rateLimit, readJson, route } from "@/lib/http";
import { requireBot } from "@/lib/botAgent";
import { botEventsSchema } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Batched telemetry: session-scoped lines go to the WhatsApp log, the rest to the bot log. */
export const POST = route(async (req: Request) => {
  assertSameOrigin(req);
  const bot = await requireBot(req);
  rateLimit(`bot:events:${bot.id}`, 300, 60_000);

  const { events } = botEventsSchema.parse(await readJson<unknown>(req));

  const owned = await prisma.whatsAppSession.findMany({
    where: { botId: bot.id },
    select: { id: true },
  });
  const ownedIds = new Set(owned.map((o) => o.id));

  let stored = 0;
  for (const event of events) {
    const sessionId = event.sessionId && ownedIds.has(event.sessionId) ? event.sessionId : null;
    if (sessionId) {
      await prisma.whatsAppLog.create({
        data: { sessionId, level: event.level, message: event.message.slice(0, 500) },
      });
    } else {
      await prisma.botLog.create({
        data: { botId: bot.id, level: event.level, message: event.message.slice(0, 500) },
      });
    }
    stored += 1;
  }

  publish(bot.userId, "whatsapp.updated", { botId: bot.id, events: stored });
  return json({ ok: true, stored });
});
