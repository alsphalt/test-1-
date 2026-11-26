import { cookies } from "next/headers";
import { prisma } from "./db";
import { SESSION_COOKIE, verifySessionToken } from "./auth";
import { forbidden, unauthorized } from "./http";

export type AuthUser = {
  id: string;
  email: string;
  name: string;
  role: "USER" | "ADMIN";
  status: "ACTIVE" | "SUSPENDED";
  sessionId: string;
};

/**
 * Resolves the signed-in user from the httpOnly cookie.
 * Validates the JWT *and* the server-side session row, so logout and
 * admin-initiated revocation take effect immediately.
 */
export async function currentUser(): Promise<AuthUser | null> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const claims = await verifySessionToken(token);
  if (!claims) return null;

  const session = await prisma.session.findUnique({
    where: { id: claims.sessionId },
    select: {
      id: true,
      userId: true,
      revokedAt: true,
      expiresAt: true,
      lastSeenAt: true,
      user: { select: { id: true, email: true, name: true, role: true, status: true } },
    },
  });

  if (!session || session.userId !== claims.userId) return null;
  if (session.revokedAt || session.expiresAt.getTime() < Date.now()) return null;
  if (session.user.status !== "ACTIVE") return null;

  if (Date.now() - session.lastSeenAt.getTime() > 60_000) {
    prisma.session
      .update({ where: { id: session.id }, data: { lastSeenAt: new Date() } })
      .catch(() => undefined);
  }

  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role: session.user.role === "ADMIN" ? "ADMIN" : "USER",
    status: "ACTIVE",
    sessionId: session.id,
  };
}

export async function requireUser(): Promise<AuthUser> {
  const user = await currentUser();
  if (!user) throw unauthorized();
  return user;
}

export async function requireAdmin(): Promise<AuthUser> {
  const user = await requireUser();
  if (user.role !== "ADMIN") throw forbidden("Administrator access required");
  return user;
}
