import { prisma } from "@/lib/db";
import { json, notFound, route } from "@/lib/http";
import { requireUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: { id: string } };

export const GET = route(async (req: Request, { params }: Ctx) => {
  const me = await requireUser();

  const bot = await prisma.bot.findFirst({
    where: { id: params.id, userId: me.id },
    select: { id: true },
  });
  if (!bot) throw notFound("Bot not found");

  const url = new URL(req.url);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 100)));
  const level = url.searchParams.get("level");

  const logs = await prisma.botLog.findMany({
    where: { botId: bot.id, ...(level && level !== "ALL" ? { level } : {}) },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { id: true, level: true, message: true, meta: true, createdAt: true },
  });

  return json({ logs });
});
