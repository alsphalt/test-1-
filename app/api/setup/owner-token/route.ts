import { audit } from "@/lib/audit";
import { assertSameOrigin, clientIp, forbidden, json, readJson, route } from "@/lib/http";
import { isOwnerEmail, rotateOwnerToken, verifyOwnerToken } from "@/lib/owner";
import { requireUser } from "@/lib/session";
import { revokeAllSetupSessions } from "@/lib/setup";
import { ownerTokenRotateSchema } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = route(async (req: Request) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const ip = clientIp(req);

  if (!isOwnerEmail(user.email)) throw forbidden("Owner access required.");

  const { current, next } = ownerTokenRotateSchema.parse(await readJson<unknown>(req));
  if (!(await verifyOwnerToken(current))) throw forbidden("The current owner token is incorrect.");

  await rotateOwnerToken(next, user.id);
  await revokeAllSetupSessions({ ownerUserId: user.id });
  await audit({
    userId: user.id,
    action: "setup.owner_token_rotate",
    target: user.email,
    ip,
  });

  return json({ ok: true });
});
