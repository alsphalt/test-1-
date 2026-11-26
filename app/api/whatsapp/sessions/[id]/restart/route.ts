import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publish } from "@/lib/events";
import { assertSameOrigin, clientIp, conflict, json, notFound, rateLimit, route } from "@/lib/http";
import { requireUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: { id: string } };

/** Reconnects using the stored credentials — no new pairing code is needed. */
export const POST = route(async (req: Request, { params }: Ctx) => {
  assertSameOrigin(req);
  const me = await requireUser();
  rateLimit(`wa:restart:${me.id}`, 30, 10 * 60_000);

  const row = await prisma.whatsAppSession.findFirst({
    where: { id: params.id, userId: me.id },
    select: { id: true, status: true, _count: { select: { keys: true } } },
  });
  if (!row) throw notFound("Session not found");
  if (row._count.keys === 0) throw conflict("No stored credentials yet — pair the number first.");

  const updated = await prisma.whatsAppSession.update({
    where: { id: row.id },
    data: { status: "RECONNECT_REQUESTED", statusDetail: "Reconnect requested." },
    select: { id: true, status: true },
  });

  publish(me.id, "whatsapp.updated", { id: row.id, status: updated.status });
  await audit({ userId: me.id, action: "whatsapp.restart", target: row.id, ip: clientIp(req) });

  return json({ ok: true, status: updated.status });
});
