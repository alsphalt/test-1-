import { audit } from "@/lib/audit";
import { assertSameOrigin, badRequest, clientIp, json, readJson, route } from "@/lib/http";
import {
  requireOwnerSetup,
  resetAccountCode,
  resetAccountPassword,
  revokeAllSetupSessions,
  setAccountStatus,
  unlinkAccount,
} from "@/lib/setup";
import { setupAccountActionSchema } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = route(async (req: Request, ctx: { params: { id: string } }) => {
  assertSameOrigin(req);
  const owner = await requireOwnerSetup();
  const ip = clientIp(req);
  const id = ctx.params.id;

  const { action, password } = setupAccountActionSchema.parse(await readJson<unknown>(req));

  switch (action) {
    case "reset-code": {
      const result = await resetAccountCode(id, owner, ip);
      return json(result);
    }
    case "reset-password": {
      if (!password) throw badRequest("Send the new password.");
      await resetAccountPassword(id, password, owner, ip);
      return json({ ok: true });
    }
    case "suspend": {
      await setAccountStatus(id, "SUSPENDED", owner, ip);
      return json({ ok: true });
    }
    case "reactivate": {
      await setAccountStatus(id, "ACTIVE", owner, ip);
      return json({ ok: true });
    }
    case "unlink": {
      await unlinkAccount(id, owner, ip);
      return json({ ok: true });
    }
    case "revoke-sessions": {
      const revoked = await revokeAllSetupSessions({ accountId: id });
      await audit({
        userId: owner.id,
        action: "setup.sessions_revoked",
        target: id,
        meta: { revoked },
        ip,
      });
      return json({ ok: true, revoked });
    }
    default:
      throw badRequest("Unknown action.");
  }
});
