import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publish } from "@/lib/events";
import { assertSameOrigin, clientIp, json, rateLimit, readJson, route } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { noteCreateSchema } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const me = await requireUser();

  const notes = await prisma.note.findMany({
    where: { userId: me.id },
    orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }],
    take: 500,
    select: {
      id: true,
      title: true,
      body: true,
      pinned: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return json({ notes });
});

export const POST = route(async (req: Request) => {
  assertSameOrigin(req);
  const me = await requireUser();
  rateLimit(`notes:create:${me.id}`, 120, 60_000);

  const input = noteCreateSchema.parse(await readJson<unknown>(req));
  const note = await prisma.note.create({
    data: { userId: me.id, title: input.title, body: input.body },
  });

  publish(me.id, "note.created", { id: note.id });
  await audit({ userId: me.id, action: "note.create", target: note.id, ip: clientIp(req) });

  return json({ note }, 201);
});
