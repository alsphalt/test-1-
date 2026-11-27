import { json, route } from "@/lib/http";
import { listSetupActivity, requireOwnerSetup } from "@/lib/setup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (req: Request) => {
  await requireOwnerSetup();
  const limit = Number(new URL(req.url).searchParams.get("limit") || 100);
  return json({ activity: await listSetupActivity(limit) });
});
