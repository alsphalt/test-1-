import { randomUUID } from "crypto";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publish } from "@/lib/events";
import { assertSameOrigin, clientIp, json, rateLimit, readJson, route } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { whatsappCreateSchema } from "@/lib/validate";
import { toPublicSession } from "@/lib/whatsapp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const shape = {
  id: true,
  label: true,
  source: true,
  botId: true,
  bot: { select: { name: true } },
  pairError: true,
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
} as const;

export const GET = route(async () => {
  const me = await requireUser();

  const rows = await prisma.whatsAppSession.findMany({
    where: { userId: me.id },
    orderBy: { createdAt: "desc" },
    select: shape,
  });

  return json({
    sessions: rows.map(toPublicSession),
    worker: { configured: true },
  });
});

export const POST = route(async (req: Request) => {
  assertSameOrigin(req);
  const me = await requireUser();
  rateLimit(`wa:create:${me.id}`, 15, 60 * 60_000);

  const input = whatsappCreateSchema.parse(await readJson<unknown>(req));

  const existing = await prisma.whatsAppSession.count({ where: { userId: me.id } });
  if (existing >= 10) {
    return json(
      { error: { code: "LIMIT_REACHED", message: "You can keep 10 WhatsApp sessions. Remove one first." } },
      409,
    );
  }

  let bot: { id: string; name: string; enabled: boolean } | null = null;
  if (input.botId) {
    bot = await prisma.bot.findFirst({
      where: { id: input.botId, userId: me.id },
      select: { id: true, name: true, enabled: true },
    });
    if (!bot) return json({ error: { code: "BOT_NOT_FOUND", message: "That bot is not yours." } }, 404);
    if (!bot.enabled) {
      return json({ error: { code: "BOT_DISABLED", message: "Enable the bot before adding sessions to it." } }, 409);
    }
  }

  const row = await prisma.whatsAppSession.create({
    data: {
      userId: me.id,
      label: input.label,
      phone: input.phone,
      botId: bot?.id ?? null,
      // A pending bot session needs its own placeholder id: the empty string is
      // shared by every waiting row and collides on (botId, externalId), which
      // limited a bot to one pending session. The bot's sync replaces it with
      // the bot-side session id once the number is paired.
      externalId: bot ? `req_${randomUUID()}` : "",
      source: bot ? "BOT" : "WORKER",
      status: "PAIRING_REQUESTED",
      pairRequestedAt: bot ? new Date() : null,
      statusDetail: bot
        ? `Waiting for ${bot.name} to issue the pairing code…`
        : "Waiting for the WhatsApp worker to issue a pairing code…",
    },
    select: shape,
  });

  publish(me.id, "whatsapp.updated", { id: row.id, status: row.status });
  await audit({
    userId: me.id,
    action: "whatsapp.create",
    target: row.id,
    meta: { label: input.label, phone: `+${input.phone}` },
    ip: clientIp(req),
  });

  return json({ session: toPublicSession(row) }, 201);
});
