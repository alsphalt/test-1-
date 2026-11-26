import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { createHash, randomBytes } from "crypto";
import { cookies } from "next/headers";
import { authSecret, isProd } from "./env";

export const SESSION_COOKIE = "dnx_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ISSUER = "darknote-nexus";
const AUDIENCE = "darknote-nexus-web";

export type SessionClaims = { userId: string; sessionId: string };

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 12);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export async function signSessionToken(claims: SessionClaims, expiresAt: Date): Promise<string> {
  return new SignJWT({ sid: claims.sessionId })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(claims.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(authSecret());
}

export async function verifySessionToken(token: string): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, authSecret(), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ["HS256"],
    });
    const userId = payload.sub;
    const sessionId = payload.sid;
    if (typeof userId !== "string" || typeof sessionId !== "string") return null;
    return { userId, sessionId };
  } catch {
    return null;
  }
}

export function setSessionCookie(token: string, expiresAt: Date): void {
  cookies().set({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure: isProd(),
    path: "/",
    expires: expiresAt,
  });
}

export function clearSessionCookie(): void {
  cookies().set({
    name: SESSION_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: isProd(),
    path: "/",
    maxAge: 0,
  });
}

/* --------------------------------- bot tokens -------------------------------- */

export function createBotToken(): { token: string; hash: string; prefix: string } {
  const token = `dnx_${randomBytes(24).toString("base64url")}`;
  return { token, hash: sha256(token), prefix: token.slice(0, 11) };
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function randomCode(length = 8): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}
