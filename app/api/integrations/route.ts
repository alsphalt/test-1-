import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { encryptSecret, maskKey } from "@/lib/crypto";
import { assertPublicUrl } from "@/lib/net";
import { assertSameOrigin, badRequest, clientIp, json, rateLimit, readJson, route } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { integrationCreateSchema } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const me = await requireUser();

  const rows = await prisma.integration.findMany({
    where: { userId: me.id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, provider: true, baseUrl: true, headerName: true, keyPrefix: true,
      status: true, lastTestAt: true, createdAt: true,
    },
  });

  return json({ integrations: rows });
});

export const POST = route(async (req: Request) => {
  assertSameOrigin(req);
  const me = await requireUser();
  rateLimit(`integrations:create:${me.id}`, 20, 60 * 60_000);

  const input = integrationCreateSchema.parse(await readJson<unknown>(req));

  try {
    assertPublicUrl(input.baseUrl);
  } catch (err) {
    throw badRequest(err instanceof Error ? err.message : "Invalid URL");
  }

  const row = await prisma.integration.create({
    data: {
      userId: me.id,
      provider: input.provider,
      baseUrl: input.baseUrl,
      headerName: input.headerName,
      keyPrefix: maskKey(input.apiKey),
      keyCipher: encryptSecret(input.apiKey),
    },
    select: {
      id: true, provider: true, baseUrl: true, headerName: true, keyPrefix: true,
      status: true, lastTestAt: true, createdAt: true,
    },
  });

  await audit({ userId: me.id, action: "integration.create", target: row.id, meta: { provider: row.provider }, ip: clientIp(req) });

  return json({ integration: row }, 201);
});
