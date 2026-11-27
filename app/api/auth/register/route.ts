import { randomUUID } from "crypto";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { hashPassword, setSessionCookie, signSessionToken, SESSION_TTL_MS } from "@/lib/auth";
import { adminEmails } from "@/lib/env";
import { assertSameOrigin, clientIp, conflict, json, rateLimit, readJson, route } from "@/lib/http";
import { registerSchema } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = route(async (req: Request) => {
  assertSameOrigin(req);
  const ip = clientIp(req);
  rateLimit(`register:${ip}`, 10, 10 * 60_000);

  const body = await readJson<unknown>(req);
  const { name, email, password } = registerSchema.parse(body);

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) throw conflict("An account with that email already exists.");

  const role = adminEmails().includes(email) ? "ADMIN" : "USER";
  const user = await prisma.user.create({
    data: { name, email, passwordHash: await hashPassword(password), role },
    select: { id: true, email: true, name: true, role: true, createdAt: true },
  });

  const sessionId = randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await prisma.session.create({
    data: {
      id: sessionId,
      userId: user.id,
      userAgent: (req.headers.get("user-agent") || "").slice(0, 300),
      ip,
      expiresAt,
    },
  });

  setSessionCookie(await signSessionToken({ userId: user.id, sessionId }, expiresAt), expiresAt);
  await audit({ userId: user.id, action: "auth.register", target: user.email, ip });

  return json({ user }, 201);
});
