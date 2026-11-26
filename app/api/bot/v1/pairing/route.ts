import { prisma } from "@/lib/db";
import { assertSameOrigin, json, route } from "@/lib/http";
import { requireBot } from "@/lib/botAgent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Pairing work the website is waiting on. The bot polls this and issues the real code. */
export const GET = route(async (req: Request) => {
  assertSameOrigin(req);
  const bot = await requireBot(req);

  const rows = await prisma.whatsAppSession.findMany({
    where: { botId: bot.id, status: "PAIRING_REQUESTED" },
    orderBy: { pairRequestedAt: "asc" },
    take: 25,
    select: {
      id: true,
      label: true,
      phone: true,
      pairRequestedAt: true,
      user: { select: { email: true } },
    },
  });

  return json({
    requests: rows.map((r) => ({
      id: r.id,
      label: r.label,
      phone: r.phone,
      requestedAt: r.pairRequestedAt?.toISOString() || null,
      owner: r.user?.email || "unknown",
    })),
  });
});
