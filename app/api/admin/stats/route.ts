import { prisma } from "@/lib/db";
import { json, route } from "@/lib/http";
import { requireAdmin } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export const GET = route(async () => {
  await requireAdmin();

  const now = new Date();
  const weekAgo = new Date(now.getTime() - 6 * 86_400_000);
  weekAgo.setHours(0, 0, 0, 0);

  const [
    users,
    activeSessions,
    bots,
    notes,
    files,
    integrations,
    recentUsers,
    recentLogs,
    recentAudit,
    onlineWindow,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.session.count({ where: { revokedAt: null, expiresAt: { gt: now } } }),
    prisma.bot.findMany({ select: { status: true, enabled: true, lastSeenAt: true } }),
    prisma.note.count(),
    prisma.fileAsset.aggregate({ _count: true, _sum: { size: true } }),
    prisma.integration.count(),
    prisma.user.findMany({ where: { createdAt: { gte: weekAgo } }, select: { createdAt: true } }),
    prisma.botLog.findMany({ where: { createdAt: { gte: weekAgo } }, select: { createdAt: true, level: true }, take: 20000 }),
    prisma.auditLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 12,
      select: { id: true, action: true, target: true, createdAt: true, user: { select: { email: true } } },
    }),
    prisma.bot.count({ where: { lastSeenAt: { gt: new Date(now.getTime() - 120_000) } } }),
  ]);

  const days: string[] = [];
  for (let i = 0; i < 7; i++) {
    days.push(dayKey(new Date(weekAgo.getTime() + i * 86_400_000)));
  }

  const signupsMap = new Map(days.map((d) => [d, 0]));
  for (const u of recentUsers) {
    const k = dayKey(u.createdAt);
    if (signupsMap.has(k)) signupsMap.set(k, (signupsMap.get(k) || 0) + 1);
  }

  const activityMap = new Map(days.map((d) => [d, { info: 0, error: 0 }]));
  for (const l of recentLogs) {
    const k = dayKey(l.createdAt);
    const bucket = activityMap.get(k);
    if (!bucket) continue;
    if (l.level === "ERROR") bucket.error += 1;
    else bucket.info += 1;
  }

  return json({
    totals: {
      users,
      activeSessions,
      bots: bots.length,
      botsOnline: onlineWindow,
      botsEnabled: bots.filter((b) => b.enabled).length,
      notes,
      files: files._count,
      storageBytes: files._sum.size || 0,
      integrations,
    },
    series: {
      days,
      signups: days.map((d) => signupsMap.get(d) || 0),
      activity: days.map((d) => activityMap.get(d) || { info: 0, error: 0 }),
    },
    recentAudit,
  });
});
