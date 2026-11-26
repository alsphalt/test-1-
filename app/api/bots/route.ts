import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { assertSameOrigin, clientIp, json, rateLimit, readJson, route } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { botCreateSchema } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const shape = {
  id: true,
  name: true,
  description: true,
  status: true,
  enabled: true,
  tokenPrefix: true,
  pairedAt: true,
  lastSeenAt: true,
  version: true,
  messagesSent: true,
  errors: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const GET = route(async () => {
  const me = await requireUser();

  const bots = await prisma.bot.findMany({
    where: { userId: me.id },
    orderBy: { createdAt: "desc" },
    select: shape,
  });

  return json({
    bots: bots.map((b) => ({ ...b, paired: Boolean(b.pairedAt) })),
  });
});

export const POST = route(async (req: Request) => {
  assertSameOrigin(req);
  const me = await requireUser();
  rateLimit(`bots:create:${me.id}`, 20, 60 * 60_000);

  const input = botCreateSchema.parse(await readJson<unknown>(req));

  const bot = await prisma.bot.create({
    data: { userId: me.id, name: input.name, description: input.description },
    select: shape,
  });

  await audit({ userId: me.id, action: "bot.create", target: bot.id, ip: clientIp(req) });

  return json({ bot: { ...bot, paired: false } }, 201);
});
