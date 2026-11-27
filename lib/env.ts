/**
 * Lazy env access. Values are read at call time so `next build` never needs
 * production secrets to be present.
 *
 * Every secret is trimmed and unquoted once, here, so a value pasted from
 * `.env.example` (or from a dashboard that kept the quotes) is read exactly as
 * intended and never as `"abc"` with literal quote characters in the key.
 */

const DEV_SECRET = "darknote-nexus-development-only-secret-change-me";

/** Values that mean "nobody filled this in yet". */
const PLACEHOLDERS = [
  "replace-me",
  "change-me",
  "changeme",
  "your-secret",
  "set-your",
  "example",
  "development-only",
];

/** Strip the whitespace and matching outer quotes a dashboard may leave behind. */
function readValue(name: string): string {
  const raw = (process.env[name] ?? "").trim();
  if (raw.length >= 2) {
    const first = raw[0];
    const last = raw[raw.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return raw.slice(1, -1).trim();
    }
  }
  return raw;
}

function looksLikePlaceholder(value: string): boolean {
  const lower = value.toLowerCase();
  return PLACEHOLDERS.some((token) => lower.includes(token));
}

export function authSecret(): Uint8Array {
  const raw = readValue("AUTH_SECRET");
  const production = process.env.NODE_ENV === "production";

  if (!raw) {
    if (production) {
      throw new Error("AUTH_SECRET is not configured");
    }
    return new TextEncoder().encode(DEV_SECRET);
  }
  if (production && raw.length < 32) {
    throw new Error("AUTH_SECRET must be at least 32 characters in production");
  }
  // A copied template value is worse than a missing one: it looks configured.
  if (production && looksLikePlaceholder(raw)) {
    throw new Error("AUTH_SECRET is still the example placeholder");
  }
  if (production && raw === readValue("ENCRYPTION_KEY")) {
    throw new Error("AUTH_SECRET and ENCRYPTION_KEY must not be the same value");
  }
  return new TextEncoder().encode(raw);
}

export function encryptionKey(): Buffer {
  const raw = readValue("ENCRYPTION_KEY");
  const production = process.env.NODE_ENV === "production";

  if (!raw) {
    if (production) {
      throw new Error("ENCRYPTION_KEY is not configured");
    }
    // deterministic dev-only key
    return Buffer.from("0".repeat(64), "hex");
  }
  if (production && looksLikePlaceholder(raw)) {
    throw new Error("ENCRYPTION_KEY is still the example placeholder");
  }
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");

  // base64 (with or without padding) must decode to exactly 32 bytes.
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new Error("ENCRYPTION_KEY must be 32 bytes (hex or base64)");
  }
  return buf;
}

/**
 * Presence-only snapshot for /api/health and the boot log. Never returns a
 * value, a prefix or a length that could narrow a guess — only whether the
 * variable is usable.
 */
export function secretStatus(name: "AUTH_SECRET" | "ENCRYPTION_KEY"):
  | "set"
  | "missing"
  | "too_short"
  | "placeholder" {
  const raw = readValue(name);
  if (!raw) return "missing";
  if (looksLikePlaceholder(raw)) return "placeholder";
  if (name === "AUTH_SECRET" && raw.length < 32) return "too_short";
  if (name === "ENCRYPTION_KEY") {
    if (/^[0-9a-fA-F]{64}$/.test(raw)) return "set";
    return Buffer.from(raw, "base64").length === 32 ? "set" : "too_short";
  }
  return "set";
}

/** True when both secrets exist, are usable and are different values. */
export function secretsConfigured(): boolean {
  return (
    secretStatus("AUTH_SECRET") === "set" &&
    secretStatus("ENCRYPTION_KEY") === "set" &&
    readValue("AUTH_SECRET") !== readValue("ENCRYPTION_KEY")
  );
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
