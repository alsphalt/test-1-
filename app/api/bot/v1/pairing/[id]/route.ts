import { prisma } from "@/lib/db";
import { publish } from "@/lib/events";
import { assertSameOrigin, conflict, json, notFound, readJson, route } from "@/lib/http";
import { requireBot } from "@/lib/botAgent";
import { botPairResultSchema } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: { id: string } };

/** The bot reports the code WhatsApp gave it (or why pairing failed). */
export const POST = route(async (req: Request, { params }: Ctx) => {
  assertSameOrigin(req);
  const bot = await requireBot(req);
  const input = botPairResultSchema.parse(await readJson<unknown>(req));

  const session = await prisma.whatsAppSession.findFirst({
    where: { id: params.id, botId: bot.id },
    select: { id: true, phone: true },
  });
  if (!session) throw notFound("Pairing request not found for this bot");
  if (input.phone && session.phone && input.phone.replace(/\D/g, "") !== session.phone) {
    throw conflict("Reported phone does not match the pairing request");
  }

  const updated = await prisma.whatsAppSession.update({
    where: { id: session.id },
    data: input.code
      ? {
          status: "PAIRING_CODE",
          pairingCode: input.code.slice(0, 16),
          pairingExpiresAt: input.expiresAt ? new Date(input.expiresAt) : new Date(Date.now() + 60_000),
          pairError: "",
          statusDetail: "Enter this code on your phone: WhatsApp → Linked devices",
          lastSeenAt: new Date(),
        }
      : {
          status: "ERROR",
          pairError: (input.error || "Pairing failed").slice(0, 300),
          statusDetail: (input.error || "Pairing failed").slice(0, 300),
          pairingCode: "",
          pairingExpiresAt: null,
          lastSeenAt: new Date(),
        },
    select: { id: true, status: true, pairingCode: true },
  });

  publish(bot.userId, "whatsapp.updated", { id: updated.id, status: updated.status });
  await prisma.whatsAppLog.create({
    data: {
      sessionId: updated.id,
      level: input.code ? "INFO" : "ERROR",
      message: input.code ? "Pairing code issued by the bot" : `Bot reported a pairing error: ${input.error}`,
    },
  });

  return json({ ok: true, status: updated.status });
});
