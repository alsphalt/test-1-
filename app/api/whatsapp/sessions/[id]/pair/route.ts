import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publish } from "@/lib/events";
import { assertSameOrigin, clientIp, conflict, json, notFound, rateLimit, route } from "@/lib/http";
import { requireUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: { id: string } };

/**
 * (Re)starts pairing: the worker sees PAIRING_REQUESTED, opens a real Baileys
 * socket and asks WhatsApp for a fresh 8-character pairing code for `phone`.
 */
export const POST = route(async (req: Request, { params }: Ctx) => {
  assertSameOrigin(req);
  const me = await requireUser();
  rateLimit(`wa:pair:${me.id}`, 20, 10 * 60_000);

  const row = await prisma.whatsAppSession.findFirst({
    where: { id: params.id, userId: me.id },
    select: { id: true, status: true, phone: true },
  });
  if (!row) throw notFound("Session not found");
  if (row.status === "CONNECTED") throw conflict("That session is already connected.");
  if (!row.phone) throw conflict("Add a phone number first.");

  const updated = await prisma.whatsAppSession.update({
    where: { id: row.id },
    data: {
      status: "PAIRING_REQUESTED",
      statusDetail: "Requesting a new pairing code…",
      pairingCode: "",
      pairingExpiresAt: null,
    },
    select: { id: true, status: true },
  });

  publish(me.id, "whatsapp.updated", { id: row.id, status: updated.status });
  await audit({ userId: me.id, action: "whatsapp.pair", target: row.id, ip: clientIp(req) });

  return json({ ok: true, status: updated.status });
});
