import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publish } from "@/lib/events";
import { assertSameOrigin, clientIp, json, notFound, route } from "@/lib/http";
import { requireUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: { id: string } };

/** Invalidates the bot token immediately — the bot must pair again. */
export const POST = route(async (req: Request, { params }: Ctx) => {
  assertSameOrigin(req);
  const me = await requireUser();

  const bot = await prisma.bot.findFirst({
    where: { id: params.id, userId: me.id },
    select: { id: true },
  });
  if (!bot) throw notFound("Bot not found");

  await prisma.$transaction([
    prisma.pairingCode.deleteMany({ where: { botId: bot.id } }),
    prisma.bot.update({
      where: { id: bot.id },
      data: {
        tokenHash: null,
        tokenPrefix: "",
        pairedAt: null,
        status: "OFFLINE",
        lastSeenAt: null,
      },
    }),
  ]);

  publish(me.id, "bot.updated", { id: bot.id, status: "OFFLINE", revoked: true });
  await audit({ userId: me.id, action: "bot.revoke", target: bot.id, ip: clientIp(req) });

  return json({ ok: true });
});
