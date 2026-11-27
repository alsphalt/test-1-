import { randomUUID } from "crypto";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { setSessionCookie, signSessionToken, verifyPassword, SESSION_TTL_MS } from "@/lib/auth";
import { ApiError, assertSameOrigin, clientIp, json, rateLimit, readJson, route } from "@/lib/http";
import { loginSchema } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GENERIC = "Invalid email or password.";

export const POST = route(async (req: Request) => {
  assertSameOrigin(req);
  const ip = clientIp(req);
  // Shared (NAT/carrier) IPs hit a low ceiling quickly; the per-account
  // limit below is what actually protects an individual account.
  rateLimit(`login:ip:${ip}`, 30, 5 * 60_000);

  const body = await readJson<unknown>(req);
  const { email, password } = loginSchema.parse(body);
  rateLimit(`login:email:${email}`, 8, 5 * 60_000);

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, name: true, role: true, status: true, passwordHash: true },
  });

  if (!user) {
    await audit({ action: "auth.login_failed", target: email, ip, meta: { reason: "no_user" } });
    throw new ApiError(401, "INVALID_CREDENTIALS", GENERIC);
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    await audit({ userId: user.id, action: "auth.login_failed", target: email, ip, meta: { reason: "bad_password" } });
    throw new ApiError(401, "INVALID_CREDENTIALS", GENERIC);
  }

  if (user.status !== "ACTIVE") {
    await audit({ userId: user.id, action: "auth.login_failed", target: email, ip, meta: { reason: "suspended" } });
    throw new ApiError(403, "ACCOUNT_SUSPENDED", "This account is suspended. Contact an administrator.");
  }

  const sessionId = randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await prisma.$transaction([
    prisma.session.create({
      data: {
        id: sessionId,
        userId: user.id,
        userAgent: (req.headers.get("user-agent") || "").slice(0, 300),
        ip,
        expiresAt,
      },
    }),
    prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }),
  ]);

  setSessionCookie(await signSessionToken({ userId: user.id, sessionId }, expiresAt), expiresAt);
  await audit({ userId: user.id, action: "auth.login", target: user.email, ip });

  return json({
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
  });
});
