/**
 * Lazy env access. Values are read at call time so `next build` never needs
 * production secrets to be present.
 */

const DEV_SECRET = "darknote-nexus-development-only-secret-change-me";

export function authSecret(): Uint8Array {
  const raw = process.env.AUTH_SECRET?.trim();
  if (!raw) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("AUTH_SECRET is not configured");
    }
    return new TextEncoder().encode(DEV_SECRET);
  }
  if (process.env.NODE_ENV === "production" && raw.length < 32) {
    throw new Error("AUTH_SECRET must be at least 32 characters in production");
  }
  return new TextEncoder().encode(raw);
}

export function encryptionKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY?.trim();
  if (!raw) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("ENCRYPTION_KEY is not configured");
    }
    // deterministic dev-only key
    return Buffer.from("0".repeat(64), "hex");
  }
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new Error("ENCRYPTION_KEY must be 32 bytes (hex or base64)");
  }
  return buf;
}

export function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function appUrl(): string {
  return (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
}

export function isProd(): boolean {
  return process.env.NODE_ENV === "production";
}
