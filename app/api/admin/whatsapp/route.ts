import { prisma } from "@/lib/db";
import { json, route } from "@/lib/http";
import { requireAdmin } from "@/lib/session";
import { toPublicSession } from "@/lib/whatsapp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Platform-wide WhatsApp overview for administrators. */
export const GET = route(async () => {
  await requireAdmin();

  const rows = await prisma.whatsAppSession.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      label: true,
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
      user: { select: { email: true } },
    },
  });

  const totals = rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.status] = (acc[row.status] || 0) + 1;
    return acc;
  }, {});

  return json({
    sessions: rows.map((row) => ({
      ...toPublicSession(row),
      owner: row.user?.email || "unknown",
    })),
    totals,
  });
});
