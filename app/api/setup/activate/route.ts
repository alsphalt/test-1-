import { assertSameOrigin, clientIp, json, rateLimit, readJson, route } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { activateSetup } from "@/lib/setup";
import { setupActivateSchema } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = route(async (req: Request) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const ip = clientIp(req);
  rateLimit(`setup-activate:${user.id}`, 6, 10 * 60_000);
  rateLimit(`setup-activate-ip:${ip}`, 12, 10 * 60_000);

  const input = setupActivateSchema.parse(await readJson<unknown>(req));
  const result = await activateSetup({ ...input, user, ip });

  return json(
    {
      status: result.status,
      requestId: result.requestId,
      message:
        "Access request submitted. The owner must approve it before you can enter your Setup dashboard.",
    },
    202,
  );
});
