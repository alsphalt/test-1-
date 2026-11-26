import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publish } from "@/lib/events";
import { assertSameOrigin, clientIp, json, readJson, route } from "@/lib/http";
import { currentUser, requireUser } from "@/lib/session";
import { profileUpdateSchema } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await currentUser();
  if (!user) return json({ user: null }, 200);

  const [bots, files, sessions, integrations, online, logs] = await Promise.all([
    prisma.bot.count({ where: { userId: user.id } }),
    prisma.fileAsset.count({ where: { userId: user.id } }),
    prisma.session.count({
      where: { userId: user.id, revokedAt: null, expiresAt: { gt: new Date() } },
    }),
    prisma.integration.count({ where: { userId: user.id } }),
    prisma.bot.count({
      where: { userId: user.id, status: "ONLINE", lastSeenAt: { gt: new Date(Date.now() - 120_000) } },
    }),
    prisma.botLog.count({ where: { bot: { userId: user.id } } }),
  ]);

  const me = await prisma.user.findUniqueOrThrow({
    where: { id: user.id },
    select: { avatar: true, createdAt: true, lastLoginAt: true },
  });

  return json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      avatar: me.avatar || "",
      sessionId: user.sessionId,
      createdAt: me.createdAt,
      lastLoginAt: me.lastLoginAt,
    },
    counts: { bots, botsOnline: online, files, sessions, integrations, logs },
  });
});

export const PATCH = route(async (req: Request) => {
  assertSameOrigin(req);
  const me = await requireUser();

  const input = profileUpdateSchema.parse(await readJson<unknown>(req));

  const user = await prisma.user.update({
    where: { id: me.id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.avatar !== undefined ? { avatar: input.avatar } : {}),
    },
    select: { id: true, email: true, name: true, role: true, avatar: true },
  });

  publish(me.id, "user.updated", { id: me.id });
  await audit({ userId: me.id, action: "user.update", target: me.id, meta: input, ip: clientIp(req) });

  return json({ user });
});
