import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { clearSessionCookie } from "@/lib/auth";
import { clientIp, json, route } from "@/lib/http";
import { currentUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = route(async (req: Request) => {
  const user = await currentUser();

  if (user) {
    await prisma.session.updateMany({
      where: { id: user.sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await audit({ userId: user.id, action: "auth.logout", target: user.email, ip: clientIp(req) });
  }

  clearSessionCookie();
  return json({ ok: true });
});
