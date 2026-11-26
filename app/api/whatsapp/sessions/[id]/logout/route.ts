import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publish } from "@/lib/events";
import { assertSameOrigin, clientIp, json, notFound, route } from "@/lib/http";
import { requireUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: { id: string } };

/**
 * Ends the WhatsApp link for real: the worker closes the socket, calls logout
 * and wipes the stored credentials. The row is kept for the audit trail.
 */
export const POST = route(async (req: Request, { params }: Ctx) => {
  assertSameOrigin(req);
  const me = await requireUser();

  const row = await prisma.whatsAppSession.findFirst({
    where: { id: params.id, userId: me.id },
    select: { id: true, status: true, source: true, botId: true },
  });
  if (!row) throw notFound("Session not found");

  if (row.source === "BOT" && row.botId) {
    await prisma.botCommand.create({ data: { botId: row.botId, sessionId: row.id, type: "LOGOUT" } });
  }

  const updated = await prisma.whatsAppSession.update({
    where: { id: row.id },
    data: {
      status: "LOGGED_OUT",
      statusDetail: "Unlinked by the owner. Credentials will be wiped.",
      pairingCode: "",
      pairingExpiresAt: null,
      connectedAt: null,
    },
    select: { id: true, status: true, source: true, botId: true },
  });

  publish(me.id, "whatsapp.updated", { id: row.id, status: updated.status });
  await audit({ userId: me.id, action: "whatsapp.logout", target: row.id, ip: clientIp(req) });

  return json({ ok: true, status: updated.status });
});
