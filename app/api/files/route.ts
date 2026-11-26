import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publish } from "@/lib/events";
import { ApiError, assertSameOrigin, clientIp, json, rateLimit, route } from "@/lib/http";
import { requireUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FILE = 4 * 1024 * 1024; // 4 MB per file
const MAX_TOTAL = 50 * 1024 * 1024; // 50 MB per account

export const GET = route(async () => {
  const me = await requireUser();

  const [files, agg] = await Promise.all([
    prisma.fileAsset.findMany({
      where: { userId: me.id },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: { id: true, name: true, mimeType: true, size: true, createdAt: true },
    }),
    prisma.fileAsset.aggregate({ where: { userId: me.id }, _sum: { size: true } }),
  ]);

  return json({ files, usedBytes: agg._sum.size || 0, quotaBytes: MAX_TOTAL });
});

export const POST = route(async (req: Request) => {
  assertSameOrigin(req);
  const me = await requireUser();
  rateLimit(`files:upload:${me.id}`, 30, 60_000);

  const type = req.headers.get("content-type") || "";
  if (!type.includes("multipart/form-data")) {
    throw new ApiError(400, "BAD_REQUEST", "Upload must be multipart/form-data");
  }

  const form = await req.formData();
  const file = form.get("file");

  if (!(file instanceof File)) throw new ApiError(400, "BAD_REQUEST", "No file received");
  if (file.size === 0) throw new ApiError(400, "BAD_REQUEST", "That file is empty");
  if (file.size > MAX_FILE) {
    throw new ApiError(413, "FILE_TOO_LARGE", "Files are limited to 4 MB each.");
  }

  const used = await prisma.fileAsset.aggregate({ where: { userId: me.id }, _sum: { size: true } });
  if ((used._sum.size || 0) + file.size > MAX_TOTAL) {
    throw new ApiError(413, "QUOTA_EXCEEDED", "Account storage limit (50 MB) reached.");
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const name = (file.name || "untitled").replace(/[\u0000-\u001f\\/]/g, "_").slice(0, 180);

  const created = await prisma.fileAsset.create({
    data: {
      userId: me.id,
      name,
      mimeType: file.type || "application/octet-stream",
      size: file.size,
      data: buffer.toString("base64"),
    },
    select: { id: true, name: true, mimeType: true, size: true, createdAt: true },
  });

  publish(me.id, "file.created", { id: created.id });
  await audit({
    userId: me.id,
    action: "file.upload",
    target: created.id,
    meta: { name, size: created.size },
    ip: clientIp(req),
  });

  return json({ file: created }, 201);
});
