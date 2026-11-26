import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { createBotToken } from "@/lib/auth";
import { publish } from "@/lib/events";
import { ApiError, assertSameOrigin, clientIp, json, rateLimit, readJson, route } from "@/lib/http";
import { pairConsumeSchema } from "@/lib/validate";
import { appUrl } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public endpoint used by an external bot/agent to redeem a pairing code.
 * Returns the bot token exactly once — it is only ever stored hashed.
 */
export const POST = route(async (req: Request) => {
  assertSameOrigin(req);
  const ip = clientIp(req);
  rateLimit(`pair:${ip}`, 10, 10 * 60_000);

  const { code, version } = pairConsumeSchema.parse(await readJson<unknown>(req));

  const record = await prisma.pairingCode.findUnique({
    where: { code },
    select: { id: true, userId: true, botId: true, usedAt: true, expiresAt: true },
  });

  if (!record) throw new ApiError(404, "INVALID_CODE", "That pairing code is not valid.");
  if (record.usedAt) throw new ApiError(409, "CODE_USED", "That code has already been used.");
  if (record.expiresAt.getTime() < Date.now()) {
    throw new ApiError(410, "CODE_EXPIRED", "That code has expired — generate a new one.");
  }

  const bot = await prisma.bot.findUnique({
    where: { id: record.botId },
    select: { id: true, name: true, userId: true },
  });
  if (!bot) throw new ApiError(404, "INVALID_CODE", "That pairing code is not valid.");

  const { token, hash, prefix } = createBotToken();

  await prisma.$transaction([
    prisma.pairingCode.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    prisma.bot.update({
      where: { id: bot.id },
      data: {
        tokenHash: hash,
        tokenPrefix: prefix,
        pairedAt: new Date(),
        status: "OFFLINE",
        version: version || "",
      },
    }),
  ]);

  publish(record.userId, "bot.paired", { id: bot.id });
  await audit({
    userId: record.userId,
    action: "bot.pair",
    target: bot.id,
    meta: { ip, version: version || "" },
    ip,
  });

  return json({
    botId: bot.id,
    name: bot.name,
    token,
    heartbeatUrl: `${appUrl()}/api/bots/heartbeat`,
  });
});
