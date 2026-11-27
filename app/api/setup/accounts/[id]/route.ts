import { assertSameOrigin, clientIp, json, route } from "@/lib/http";
import { deleteAccount, requireOwnerSetup } from "@/lib/setup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const DELETE = route(async (req: Request, ctx: { params: { id: string } }) => {
  assertSameOrigin(req);
  const owner = await requireOwnerSetup();
  await deleteAccount(ctx.params.id, owner, clientIp(req));
  return json({ ok: true });
});
