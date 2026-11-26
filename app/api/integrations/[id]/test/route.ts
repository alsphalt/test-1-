import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { decryptSecret } from "@/lib/crypto";
import { assertPublicUrl } from "@/lib/net";
import { assertSameOrigin, badRequest, clientIp, json, notFound, rateLimit, route } from "@/lib/http";
import { requireUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: { id: string } };

/** Performs a real outbound request with the stored credential. */
export const POST = route(async (req: Request, { params }: Ctx) => {
  assertSameOrigin(req);
  const me = await requireUser();
  rateLimit(`integrations:test:${me.id}`, 20, 5 * 60_000);

  const row = await prisma.integration.findFirst({
    where: { id: params.id, userId: me.id },
    select: { id: true, baseUrl: true, headerName: true, keyCipher: true },
  });
  if (!row) throw notFound("Integration not found");

  let url: URL;
  try {
    url = assertPublicUrl(row.baseUrl);
  } catch (err) {
    throw badRequest(err instanceof Error ? err.message : "Invalid URL");
  }

  const started = Date.now();
  let ok = false;
  let status = 0;
  let snippet = "";
  let error = "";

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { [row.headerName]: decryptSecret(row.keyCipher), Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
      redirect: "follow",
    });
    status = res.status;
    ok = res.ok;
    const text = await res.text();
    snippet = text.slice(0, 240);
  } catch (err) {
    error = err instanceof Error ? err.message : "Request failed";
  }

  const latency = Date.now() - started;

  await prisma.integration.update({
    where: { id: row.id },
    data: { status: ok ? "OK" : "FAILED", lastTestAt: new Date() },
  });

  await audit({
    userId: me.id,
    action: "integration.test",
    target: row.id,
    meta: { status, ok, latency },
    ip: clientIp(req),
  });

  return json({ ok, status, latency, snippet, error });
});
