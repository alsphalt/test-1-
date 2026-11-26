import { prisma } from "@/lib/db";
import { json, route } from "@/lib/http";
import { requireAdmin } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (req: Request) => {
  await requireAdmin();

  const url = new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 25)));
  const q = (url.searchParams.get("q") || "").trim();

  const where = q ? { OR: [{ email: { contains: q } }, { name: { contains: q } }] } : {};

  const [total, users] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true, email: true, name: true, role: true, status: true,
        createdAt: true, lastLoginAt: true,
        _count: { select: { bots: true, notes: true, files: true, sessions: true } },
      },
    }),
  ]);

  return json({ users, total, page, pages: Math.max(1, Math.ceil(total / limit)) });
});
