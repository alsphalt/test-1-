import { assertSameOrigin, clientIp, json, readJson, route } from "@/lib/http";
import { createSetupAccount, listAccounts, requireOwnerSetup } from "@/lib/setup";
import { setupAccountCreateSchema } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requireOwnerSetup();
  return json({ accounts: await listAccounts() });
});

export const POST = route(async (req: Request) => {
  assertSameOrigin(req);
  const owner = await requireOwnerSetup();
  const ip = clientIp(req);

  const input = setupAccountCreateSchema.parse(await readJson<unknown>(req));
  const created = await createSetupAccount(
    {
      username: input.username,
      password: input.password,
      phone: input.phone,
      displayName: input.displayName,
      mainEmail: input.mainEmail || undefined,
    },
    owner,
    { ip },
  );

  // The code is returned exactly once, to the owner who just created it.
  return json(
    {
      account: created.account,
      setupCode: created.code,
      delivery: created.delivery,
    },
    201,
  );
});
