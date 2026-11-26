import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publish } from "@/lib/events";
import { assertSameOrigin, clientIp, json, notFound, rateLimit, readJson, route } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { noteUpdateSchema } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: { id: string } };

export const PATCH = route(async (req: Request, { params }: Ctx) => {
  assertSameOrigin(req);
  const me = await requireUser();
  rateLimit(`notes:update:${me.id}`, 600, 60_000);

  const input = noteUpdateSchema.parse(await readJson<unknown>(req));

  const existing = await prisma.note.findFirst({
    where: { id: params.id, userId: me.id },
    select: { id: true },
  });
  if (!existing) throw notFound("Note not found");

  const note = await prisma.note.update({
    where: { id: existing.id },
    data: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
    },
  });

  publish(me.id, "note.updated", { id: note.id, pinned: note.pinned });

  return json({ note });
});

export const DELETE = route(async (req: Request, { params }: Ctx) => {
  assertSameOrigin(req);
  const me = await requireUser();

  const existing = await prisma.note.findFirst({
    where: { id: params.id, userId: me.id },
    select: { id: true },
  });
  if (!existing) throw notFound("Note not found");

  await prisma.note.delete({ where: { id: existing.id } });
  publish(me.id, "note.deleted", { id: existing.id });
  await audit({ userId: me.id, action: "note.delete", target: existing.id, ip: clientIp(req) });

  return json({ ok: true });
});
