import { assertSameOrigin, json, route } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { clearSetupCookie, lockSetup } from "@/lib/setup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = route(async (req: Request) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const locked = await lockSetup(user);
  clearSetupCookie();
  return json({ ok: true, locked });
});
