import { prisma } from "@/lib/db";
import { json, notFound, route } from "@/lib/http";
import { requireUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: { id: string } };

export const GET = route(async (req: Request, { params }: Ctx) => {
  const me = await requireUser();
  const url = new URL(req.url);
  const limit = Math.min(300, Math.max(1, Number(url.searchParams.get("limit") || 80)));

  const owned = await prisma.whatsAppSession.findFirst({
    where: { id: params.id, userId: me.id },
    select: { id: true },
  });
  if (!owned) throw notFound("Session not found");

  const logs = await prisma.whatsAppLog.findMany({
    where: { sessionId: owned.id },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { id: true, level: true, message: true, createdAt: true },
  });

  return json({ logs });
});
