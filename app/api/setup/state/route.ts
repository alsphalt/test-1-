import { json, route } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { setupState } from "@/lib/setup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await requireUser();
  return json(await setupState(user));
});
