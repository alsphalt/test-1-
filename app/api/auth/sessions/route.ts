import { prisma } from "@/lib/db";
import { json, route, assertSameOrigin, clientIp } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const me = await requireUser();

  const sessions = await prisma.session.findMany({
    where: { userId: me.id, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastSeenAt: "desc" },
    take: 50,
    select: { id: true, userAgent: true, ip: true, createdAt: true, lastSeenAt: true, expiresAt: true },
  });

  return json({
    sessions: sessions.map((s) => ({ ...s, current: s.id === me.sessionId })),
  });
});

/** Revokes every session except the one making the request. */
export const DELETE = route(async (req: Request) => {
  assertSameOrigin(req);
  const me = await requireUser();

  const result = await prisma.session.updateMany({
    where: { userId: me.id, revokedAt: null, id: { not: me.sessionId } },
    data: { revokedAt: new Date() },
  });

  await audit({ userId: me.id, action: "auth.session_revoked", target: "all-others", meta: { count: result.count }, ip: clientIp(req) });

  return json({ ok: true, revoked: result.count });
});
