import { randomUUID } from "crypto";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { randomCode } from "@/lib/auth";
import { assertSameOrigin, clientIp, json, notFound, rateLimit, route } from "@/lib/http";
import { requireUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: { id: string } };

const TTL_MS = 10 * 60_000;

export const POST = route(async (req: Request, { params }: Ctx) => {
  assertSameOrigin(req);
  const me = await requireUser();
  rateLimit(`bots:pair:${me.id}`, 30, 10 * 60_000);

  const bot = await prisma.bot.findFirst({
    where: { id: params.id, userId: me.id },
    select: { id: true, name: true },
  });
  if (!bot) throw notFound("Bot not found");

  const expiresAt = new Date(Date.now() + TTL_MS);

  // Only one live code per bot.
  await prisma.pairingCode.deleteMany({ where: { botId: bot.id, usedAt: null } });

  const code = await prisma.pairingCode.create({
    data: { id: randomUUID(), code: randomCode(8), userId: me.id, botId: bot.id, expiresAt },
  });

  await audit({ userId: me.id, action: "bot.pair_code", target: bot.id, ip: clientIp(req) });

  return json({ code: code.code, expiresAt: code.expiresAt, botId: bot.id, botName: bot.name });
});
