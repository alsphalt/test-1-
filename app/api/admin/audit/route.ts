import { prisma } from "@/lib/db";
import { json, route } from "@/lib/http";
import { requireAdmin } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (req: Request) => {
  await requireAdmin();

  const url = new URL(req.url);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 100)));
  const action = url.searchParams.get("action");

  const logs = await prisma.auditLog.findMany({
    where: action && action !== "ALL" ? { action } : {},
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true, action: true, target: true, meta: true, ip: true, createdAt: true,
      user: { select: { email: true, name: true } },
    },
  });

  return json({ logs });
});
