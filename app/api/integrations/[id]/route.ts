import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { assertSameOrigin, clientIp, json, notFound, route } from "@/lib/http";
import { requireUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: { id: string } };

export const DELETE = route(async (req: Request, { params }: Ctx) => {
  assertSameOrigin(req);
  const me = await requireUser();

  const row = await prisma.integration.findFirst({
    where: { id: params.id, userId: me.id },
    select: { id: true },
  });
  if (!row) throw notFound("Integration not found");

  await prisma.integration.delete({ where: { id: row.id } });
  await audit({ userId: me.id, action: "integration.delete", target: row.id, ip: clientIp(req) });

  return json({ ok: true });
});
