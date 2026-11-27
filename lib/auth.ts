import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { createHash, randomBytes } from "crypto";
import { cookies } from "next/headers";
import { authSecret, isProd } from "./env";

/**
 * SameSite mode for the session cookie. Same-origin deployments keep `lax`;
 * a frontend on another origin needs `none` (which browsers accept only with
 * Secure, so it is HTTPS-only in practice).
 */
export function cookieSameSite(): "lax" | "strict" | "none" {
  const raw = (process.env.COOKIE_SAMESITE || "lax").toLowerCase();
  if (raw === "none" || raw === "strict") return raw;
  return "lax";
}

/**
 * Cookie flags that actually work.
 *
 * `SameSite=None` is rejected by every modern browser unless the cookie is also
 * `Secure`, and `Secure` cookies are dropped over plain HTTP. Deriving both from
 * the same fact (is this deployment HTTPS?) prevents a login that returns 200 but
 * silently loses its session.
 */
export function sessionCookieSecurity(): { sameSite: "lax" | "strict" | "none"; secure: boolean } {
  const https = process.env.APP_URL?.trim()
    ? process.env.APP_URL.trim().startsWith("https://")
    : isProd();

  let sameSite = cookieSameSite();
  if (sameSite === "none" && !https) {
    // Downgrade rather than send a cookie the browser will discard.
    sameSite = "lax";
    console.warn(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "warn",
        event: "cookie.samesite_downgraded",
        detail: "COOKIE_SAMESITE=none requires HTTPS; using lax for this request.",
      }),
    );
  }

  return { sameSite, secure: https };
}


export const SESSION_COOKIE = "dnx_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ISSUER = "darknote-nexus";
const AUDIENCE = "darknote-nexus-web";

export type SessionClaims = { userId: string; sessionId: string };

/**
 * bcrypt hashes at most 72 bytes and truncates longer input, so the API
 * validates length before calling this.
 */
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

/**
 * A missing or unusable secret is a deployment fault, not a bad session.
 * Without this split the catch below would turn "AUTH_SECRET is not
 * configured" into a silent null and every request would look like an
 * ordinary 401, which is exactly how a misconfiguration hides for days.
 */
export function isSecretConfigError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /^(AUTH_SECRET|ENCRYPTION_KEY)\b/.test(message);
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
  } catch (err) {
    if (isSecretConfigError(err)) throw err;
    // Expired, tampered or foreign-signed: treat as "no session".
    return null;
  }
}

export function setSessionCookie(token: string, expiresAt: Date): void {
  const { sameSite, secure } = sessionCookieSecurity();
  cookies().set({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite,
    secure,
    path: "/",
    expires: expiresAt,
  });
}

export function clearSessionCookie(): void {
  const { sameSite, secure } = sessionCookieSecurity();
  cookies().set({
    name: SESSION_COOKIE,
    value: "",
    httpOnly: true,
    sameSite,
    secure,
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
