import { assertSameOrigin, clientIp, json, rateLimit, readJson, route } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { setupState, unlockAsOwner, unlockWithCode } from "@/lib/setup";
import { setupUnlockSchema } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = route(async (req: Request) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const ip = clientIp(req);

  // Brute-force guard: per account and per IP.
  rateLimit(`setup-unlock:${user.id}`, 8, 10 * 60_000);
  rateLimit(`setup-unlock-ip:${ip}`, 20, 10 * 60_000);

  const input = setupUnlockSchema.parse(await readJson<unknown>(req));

  if (input.ownerToken) {
    await unlockAsOwner({
      user,
      token: input.ownerToken,
      ip,
      userAgent: req.headers.get("user-agent"),
    });
  } else {
    await unlockWithCode({
      user,
      code: input.code!,
      ip,
      userAgent: req.headers.get("user-agent"),
    });
  }

  return json({ ok: true, state: await setupState(user) });
});
