/**
 * Lazy env access. Values are read at call time so `next build` never needs
 * production secrets to be present, and a deployment that receives a variable
 * after it was built still reads the live value from the runtime.
 *
 * Two failure modes are handled here, because both look identical from the UI
 * ("AUTH_SECRET is missing") while needing different fixes:
 *
 *   1. The value is present but not under the exact name this app reads. The
 *      canonical name stays AUTH_SECRET; a small, explicit alias list catches a
 *      project that configured the same secret as NEXTAUTH_SECRET or
 *      SESSION_SECRET. The alias that was used is reported (name only).
 *
 *   2. The value is present but not clean: a dashboard keeps the quotes, a
 *      trailing carriage return, a byte-order mark, or a pasted `NAME=value`
 *      line. Normalising once, here, means the value used for signing is the
 *      value the operator intended.
 *
 * Nothing in this module may run in a browser: a secret read from
 * `process.env` inside a client bundle is either `undefined` (silently wrong)
 * or inlined at build time (a leak). `assertServer()` makes that a loud,
 * immediate error instead.
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

/**
 * Accepted names, canonical first. Order is significant: the first name that
 * holds a usable value wins, so a project with both set keeps its AUTH_SECRET.
 */
const AUTH_SECRET_NAMES = ["AUTH_SECRET", "NEXTAUTH_SECRET", "SESSION_SECRET"] as const;
const ENCRYPTION_KEY_NAMES = ["ENCRYPTION_KEY", "ENCRYPTION_SECRET", "NEXT_PRIVATE_ENCRYPTION_KEY"] as const;

type AuthSecretName = (typeof AUTH_SECRET_NAMES)[number];
type EncryptionKeyName = (typeof ENCRYPTION_KEY_NAMES)[number];

export type SecretName = AuthSecretName | EncryptionKeyName;

/** Every name this module will look at, for presence diagnostics. */
const ALL_NAMES: readonly SecretName[] = [...AUTH_SECRET_NAMES, ...ENCRYPTION_KEY_NAMES];

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * Browser guard. `lib/env.ts` is server configuration; importing it from a
 * client component would ship a build-time snapshot of the environment to the
 * browser and silently disable signing on the server. Fail loudly instead.
 */
function assertServer(): void {
  if (typeof window !== "undefined") {
    throw new Error(
      "Server configuration was imported into a browser bundle. Read secrets only from route handlers, server components or middleware.",
    );
  }
}

/** Strip the whitespace, quotes and stray prefixes a dashboard may add. */
function normalizeSecret(raw: string, name: string): string {
  let value = raw.replace(/^\uFEFF/, "").replace(/[\u200B-\u200D\u2060]/g, "").trim();
  value = value.replace(/^export\s+/i, "").trim();

  // A pasted `NAME=value` line: only strip the prefix when it is one of the
  // names we know, so a base64 value ending in `=` is never touched.
  const eq = value.indexOf("=");
  if (eq > 0 && ALL_NAMES.includes(value.slice(0, eq).trim() as SecretName)) {
    value = value.slice(eq + 1).trim();
  } else if (value.startsWith(`${name}=`)) {
    value = value.slice(name.length + 1).trim();
  }

  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      value = value.slice(1, -1).trim();
    }
  }
  return value;
}

/** The first name in `names` that carries a non-empty value. */
function resolve(names: readonly SecretName[]): { name: SecretName | null; value: string } {
  for (const name of names) {
    const raw = process.env[name];
    if (typeof raw !== "string") continue;
    const value = normalizeSecret(raw, name);
    if (value) return { name, value };
  }
  return { name: null, value: "" };
}

function looksLikePlaceholder(value: string): boolean {
  const lower = value.toLowerCase();
  return PLACEHOLDERS.some((token) => lower.includes(token));
}

/**
 * One structured, secret-free line per process, so a deployment log answers
 * "which name did the runtime actually see?" without ever printing a value.
 */
let announced = false;
function announce(event: string, detail: Record<string, unknown>): void {
  if (announced) return;
  announced = true;
  console.log(
    JSON.stringify({ ts: new Date().toISOString(), level: "info", event, ...detail }),
  );
}

export function authSecret(): Uint8Array {
  assertServer();
  const { name, value } = resolve(AUTH_SECRET_NAMES);

  if (!value) {
    announce("auth.secret_resolution", {
      authSecretName: null,
      lookedFor: AUTH_SECRET_NAMES,
      present: AUTH_SECRET_NAMES.filter((n) => Boolean(process.env[n]?.trim())),
    });
    if (isProduction()) {
      throw new Error("AUTH_SECRET is not configured");
    }
    return new TextEncoder().encode(DEV_SECRET);
  }
  if (name !== "AUTH_SECRET") {
    announce("auth.secret_resolution", { authSecretName: name, canonicalName: "AUTH_SECRET" });
  }
  if (isProduction() && value.length < 32) {
    throw new Error("AUTH_SECRET must be at least 32 characters in production");
  }
  // A copied template value is worse than a missing one: it looks configured.
  if (isProduction() && looksLikePlaceholder(value)) {
    throw new Error("AUTH_SECRET is still the example placeholder");
  }
  if (isProduction() && value === resolve(ENCRYPTION_KEY_NAMES).value) {
    throw new Error("AUTH_SECRET and ENCRYPTION_KEY must not be the same value");
  }
  return new TextEncoder().encode(value);
}

export function encryptionKey(): Buffer {
  assertServer();
  const { value } = resolve(ENCRYPTION_KEY_NAMES);

  if (!value) {
    if (isProduction()) {
      throw new Error("ENCRYPTION_KEY is not configured");
    }
    // deterministic dev-only key
    return Buffer.from("0".repeat(64), "hex");
  }
  if (isProduction() && looksLikePlaceholder(value)) {
    throw new Error("ENCRYPTION_KEY is still the example placeholder");
  }
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, "hex");

  // base64 (with or without padding) must decode to exactly 32 bytes.
  const buf = Buffer.from(value, "base64");
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
type Status = "set" | "missing" | "too_short" | "placeholder";

function statusOf(name: SecretName, value: string): Status {
  if (!value) return "missing";
  if (looksLikePlaceholder(value)) return "placeholder";
  if (AUTH_SECRET_NAMES.includes(name as AuthSecretName) && value.length < 32) return "too_short";
  if (ENCRYPTION_KEY_NAMES.includes(name as EncryptionKeyName)) {
    if (/^[0-9a-fA-F]{64}$/.test(value)) return "set";
    return Buffer.from(value, "base64").length === 32 ? "set" : "too_short";
  }
  return "set";
}

export function secretStatus(name: SecretName): Status {
  const raw = process.env[name];
  return statusOf(name, typeof raw === "string" ? normalizeSecret(raw, name) : "");
}

/**
 * Which of the accepted names carries a usable value, and which one the app
 * will actually use. Names only — safe to serve publicly, and the fastest way
 * to tell "not configured" from "configured under another name".
 */
export function secretSources(): {
  authSecret: { name: AuthSecretName | null; status: Status };
  encryptionKey: { name: EncryptionKeyName | null; status: Status };
  checked: { authSecret: readonly string[]; encryptionKey: readonly string[] };
  /** Names that exist in the runtime but are empty after normalisation. */
  presentButUnusable: string[];
} {
  const auth = resolve(AUTH_SECRET_NAMES);
  const enc = resolve(ENCRYPTION_KEY_NAMES);

  return {
    authSecret: {
      name: auth.name as AuthSecretName | null,
      status: statusOf((auth.name ?? "AUTH_SECRET") as SecretName, auth.value),
    },
    encryptionKey: {
      name: enc.name as EncryptionKeyName | null,
      status: statusOf((enc.name ?? "ENCRYPTION_KEY") as SecretName, enc.value),
    },
    checked: { authSecret: AUTH_SECRET_NAMES, encryptionKey: ENCRYPTION_KEY_NAMES },
    presentButUnusable: ALL_NAMES.filter((name) => {
      const raw = process.env[name];
      return typeof raw === "string" && raw.length > 0 && !normalizeSecret(raw, name);
    }),
  };
}

/** True when both secrets exist under any accepted name and differ. */
export function secretsConfigured(): boolean {
  const sources = secretSources();
  const auth = resolve(AUTH_SECRET_NAMES).value;
  const enc = resolve(ENCRYPTION_KEY_NAMES).value;
  return sources.authSecret.status === "set" && sources.encryptionKey.status === "set" && auth !== enc;
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
  return isProduction();
}
