import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import {
  assertSameOrigin,
  badRequest,
  clientIp,
  forbidden,
  json,
  notFound,
  readJson,
  route,
} from "@/lib/http";
import { requireAdmin } from "@/lib/session";
import { adminUserPatchSchema } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: { id: string } };

export const PATCH = route(async (req: Request, { params }: Ctx) => {
  assertSameOrigin(req);
  const me = await requireAdmin();
  const input = adminUserPatchSchema.parse(await readJson<unknown>(req));

  const target = await prisma.user.findUnique({
    where: { id: params.id },
    select: { id: true, email: true, role: true },
  });
  if (!target) throw notFound("User not found");

  if (target.id === me.id && (input.role === "USER" || input.status === "SUSPENDED")) {
    throw badRequest("You cannot demote or suspend your own account.");
  }

  const updated = await prisma.user.update({
    where: { id: target.id },
    data: {
      ...(input.role ? { role: input.role } : {}),
      ...(input.status ? { status: input.status } : {}),
    },
    select: { id: true, email: true, role: true, status: true },
  });

  // Suspension revokes every active session immediately.
  if (input.status === "SUSPENDED") {
    await prisma.session.updateMany({
      where: { userId: target.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  await audit({
    userId: me.id,
    action: "admin.user_update",
    target: target.id,
    meta: { email: target.email, ...input },
    ip: clientIp(req),
  });

  return json({ user: updated });
});

export const DELETE = route(async (req: Request, { params }: Ctx) => {
  assertSameOrigin(req);
  const me = await requireAdmin();

  if (params.id === me.id) throw forbidden("You cannot delete your own account.");

  const target = await prisma.user.findUnique({
    where: { id: params.id },
    select: { id: true, email: true },
  });
  if (!target) throw notFound("User not found");

  await prisma.user.delete({ where: { id: target.id } });
  await audit({
    userId: me.id,
    action: "admin.user_delete",
    target: target.id,
    meta: { email: target.email },
    ip: clientIp(req),
  });

  return json({ ok: true });
});
