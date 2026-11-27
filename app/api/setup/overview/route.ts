import { json, route } from "@/lib/http";
import { requireOwnerSetup, setupOverview } from "@/lib/setup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requireOwnerSetup();
  return json(await setupOverview());
});
