import { assertSameOrigin, clientIp, json, readJson, route } from "@/lib/http";
import { decideRequest, requireOwnerSetup } from "@/lib/setup";
import { setupDecisionSchema } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = route(async (req: Request, ctx: { params: { id: string } }) => {
  assertSameOrigin(req);
  const owner = await requireOwnerSetup();
  const { decision } = setupDecisionSchema.parse(await readJson<unknown>(req));

  const result = await decideRequest({
    requestId: ctx.params.id,
    decision,
    owner,
    ip: clientIp(req),
  });

  const { publish } = await import("@/lib/events");
  publish(owner.id, "sync", { scope: "setup" });
  return json(result);
});
