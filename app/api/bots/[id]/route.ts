import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publish } from "@/lib/events";
import { assertSameOrigin, clientIp, json, notFound, readJson, route } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { botUpdateSchema } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: { id: string } };

async function ownedBot(userId: string, botId: string) {
  const bot = await prisma.bot.findFirst({ where: { id: botId, userId }, select: { id: true, status: true } });
  if (!bot) throw notFound("Bot not found");
  return bot;
}

export const GET = route(async (_req: Request, { params }: Ctx) => {
  const me = await requireUser();
  await ownedBot(me.id, params.id);

  const bot = await prisma.bot.findUnique({
    where: { id: params.id },
    select: {
      id: true, name: true, description: true, status: true, enabled: true, tokenPrefix: true,
      pairedAt: true, lastSeenAt: true, version: true, messagesSent: true, errors: true,
      createdAt: true, updatedAt: true,
    },
  });

  const [logs, recent] = await Promise.all([
    prisma.botLog.count({ where: { botId: params.id } }),
    prisma.botLog.findMany({
      where: { botId: params.id },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { id: true, level: true, message: true, createdAt: true },
    }),
  ]);

  return json({ bot: { ...bot, paired: Boolean(bot?.pairedAt) }, logs, recent });
});

export const PATCH = route(async (req: Request, { params }: Ctx) => {
  assertSameOrigin(req);
  const me = await requireUser();
  const bot = await ownedBot(me.id, params.id);

  const input = botUpdateSchema.parse(await readJson<unknown>(req));

  const updated = await prisma.bot.update({
    where: { id: bot.id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.enabled !== undefined
        ? { enabled: input.enabled, status: input.enabled ? (bot.status === "PAUSED" ? "OFFLINE" : bot.status) : "PAUSED" }
        : {}),
    },
    select: { id: true, name: true, description: true, enabled: true, status: true, updatedAt: true },
  });

  publish(me.id, "bot.updated", { id: updated.id, status: updated.status });
  await audit({ userId: me.id, action: "bot.update", target: updated.id, meta: input, ip: clientIp(req) });

  return json({ bot: updated });
});

export const DELETE = route(async (req: Request, { params }: Ctx) => {
  assertSameOrigin(req);
  const me = await requireUser();
  const bot = await ownedBot(me.id, params.id);

  await prisma.$transaction([
    prisma.pairingCode.deleteMany({ where: { botId: bot.id } }),
    prisma.bot.delete({ where: { id: bot.id } }),
  ]);

  publish(me.id, "bot.updated", { id: bot.id, deleted: true });
  await audit({ userId: me.id, action: "bot.delete", target: bot.id, ip: clientIp(req) });

  return json({ ok: true });
});
