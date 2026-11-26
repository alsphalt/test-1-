import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { clearSessionCookie } from "@/lib/auth";
import { assertSameOrigin, clientIp, forbidden, json, notFound, route } from "@/lib/http";
import { requireUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: { id: string } };

export const DELETE = route(async (req: Request, { params }: Ctx) => {
  assertSameOrigin(req);
  const me = await requireUser();

  const session = await prisma.session.findUnique({
    where: { id: params.id },
    select: { id: true, userId: true, revokedAt: true },
  });

  if (!session) throw notFound("Session not found");
  if (session.userId !== me.id) throw forbidden("That session belongs to another account");

  await prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
  await audit({ userId: me.id, action: "auth.session_revoked", target: session.id, ip: clientIp(req) });

  const current = session.id === me.sessionId;
  if (current) clearSessionCookie();

  return json({ ok: true, current });
});
