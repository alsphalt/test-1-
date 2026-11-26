import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publish } from "@/lib/events";
import { assertSameOrigin, clientIp, json, notFound, route } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { toPublicSession } from "@/lib/whatsapp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: { id: string } };

export const GET = route(async (_req: Request, { params }: Ctx) => {
  const me = await requireUser();

  const row = await prisma.whatsAppSession.findFirst({
    where: { id: params.id, userId: me.id },
    select: {
      id: true,
      label: true,
      phone: true,
      status: true,
      statusDetail: true,
      pairingCode: true,
      pairingExpiresAt: true,
      meJid: true,
      meNumber: true,
      platform: true,
      connectedAt: true,
      lastSeenAt: true,
      disconnectCount: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { logs: true } },
    },
  });
  if (!row) throw notFound("Session not found");

  const logs = await prisma.whatsAppLog.findMany({
    where: { sessionId: row.id },
    orderBy: { createdAt: "desc" },
    take: 80,
    select: { id: true, level: true, message: true, createdAt: true },
  });

  return json({ session: toPublicSession(row), logs });
});

export const DELETE = route(async (req: Request, { params }: Ctx) => {
  assertSameOrigin(req);
  const me = await requireUser();

  const row = await prisma.whatsAppSession.findFirst({
    where: { id: params.id, userId: me.id },
    select: { id: true, label: true },
  });
  if (!row) throw notFound("Session not found");

  await prisma.whatsAppSession.delete({ where: { id: row.id } });

  publish(me.id, "whatsapp.updated", { id: row.id, deleted: true });
  await audit({ userId: me.id, action: "whatsapp.delete", target: row.id, ip: clientIp(req) });

  return json({ ok: true });
});
