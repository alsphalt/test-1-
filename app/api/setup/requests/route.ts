import { json, route } from "@/lib/http";
import { listRequests, requireOwnerSetup } from "@/lib/setup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (req: Request) => {
  await requireOwnerSetup();
  const status = new URL(req.url).searchParams.get("status") || "PENDING";
  return json({ requests: await listRequests(status) });
});
