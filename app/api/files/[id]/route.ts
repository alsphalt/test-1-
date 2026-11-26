import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publish } from "@/lib/events";
import { assertSameOrigin, clientIp, json, notFound, route } from "@/lib/http";
import { requireUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: { id: string } };

/** Streams the stored bytes. Always served as an attachment, never inline. */
export const GET = route(async (_req: Request, { params }: Ctx) => {
  const me = await requireUser();

  const file = await prisma.fileAsset.findFirst({
    where: { id: params.id, userId: me.id },
    select: { name: true, mimeType: true, data: true, size: true },
  });
  if (!file) throw notFound("File not found");

  const bytes = Buffer.from(file.data, "base64");
  const safeName = encodeURIComponent(file.name);

  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(bytes.length),
      "Content-Disposition": `attachment; filename*=UTF-8''${safeName}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
});

export const DELETE = route(async (req: Request, { params }: Ctx) => {
  assertSameOrigin(req);
  const me = await requireUser();

  const file = await prisma.fileAsset.findFirst({
    where: { id: params.id, userId: me.id },
    select: { id: true },
  });
  if (!file) throw notFound("File not found");

  await prisma.fileAsset.delete({ where: { id: file.id } });
  publish(me.id, "file.deleted", { id: file.id });
  await audit({ userId: me.id, action: "file.delete", target: file.id, ip: clientIp(req) });

  return json({ ok: true });
});
