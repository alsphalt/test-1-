import { prisma } from "@/lib/db";
import { json, route } from "@/lib/http";
import { requireUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Recent log lines across every bot the signed-in user owns. */
export const GET = route(async (req: Request) => {
  const me = await requireUser();
  const url = new URL(req.url);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 60)));
  const botId = url.searchParams.get("botId") || "";

  const logs = await prisma.botLog.findMany({
    where: { bot: { userId: me.id, ...(botId ? { id: botId } : {}) } },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      level: true,
      message: true,
      createdAt: true,
      botId: true,
      bot: { select: { name: true } },
    },
  });

  return json({ logs });
});
