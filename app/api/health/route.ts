import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { probeDatabase } from "@/lib/dbprobe";
import { configuredOrigins } from "@/lib/origin";
import { sessionCookieSecurity } from "@/lib/auth";
import { secretSources, secretsConfigured } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Deployment diagnostics. Safe to expose: it reports whether configuration is
 * present and how far a database connection gets — never values, credentials,
 * connection strings or user data. The host name is partially masked.
 */
function presence(value: string | undefined): "set" | "missing" {
  return value && value.trim().length > 0 ? "set" : "missing";
}

export async function GET() {
  const appUrl = process.env.APP_URL ?? "";

  const allowedOrigins = configuredOrigins();
  const cookie = sessionCookieSecurity();

  // Resolved status, not just the canonical name: a value found under an
  // accepted alias (NEXTAUTH_SECRET, SESSION_SECRET, …) counts as configured.
  const sources = secretSources();

  const env = {
    AUTH_SECRET: sources.authSecret.status,
    ENCRYPTION_KEY: sources.encryptionKey.status,
    DATABASE_URL: presence(process.env.DATABASE_URL),
    DIRECT_URL: presence(process.env.DIRECT_URL),
    APP_URL: presence(process.env.APP_URL),
    ADMIN_EMAILS: presence(process.env.ADMIN_EMAILS),
    OWNER_EMAILS: presence(process.env.OWNER_EMAILS),
    FRAME_ANCESTORS: presence(process.env.FRAME_ANCESTORS),
    COOKIE_SAMESITE: presence(process.env.COOKIE_SAMESITE),
  } as const;

  const probe = await probeDatabase();

  let sessions: number | null = null;
  if (probe.schema) {
    try {
      sessions = await prisma.session.count({
        where: { revokedAt: null, expiresAt: { gt: new Date() } },
      });
    } catch {
      /* advisory only */
    }
  }

  const warnings: string[] = [];
  if (env.AUTH_SECRET === "missing") {
    warnings.push(
      `No usable AUTH_SECRET in this deployment's runtime (checked ${sources.checked.authSecret.join(", ")}). If it is set in the dashboard, this deployment predates it — Vercel snapshots variables per deployment, so only a new build sees them.`,
    );
  }
  if (env.AUTH_SECRET === "too_short") warnings.push("AUTH_SECRET is shorter than 32 characters.");
  if (env.AUTH_SECRET === "placeholder") warnings.push("AUTH_SECRET is still the example placeholder value.");
  if (env.ENCRYPTION_KEY === "missing") {
    warnings.push("ENCRYPTION_KEY is missing — stored integration keys cannot be decrypted.");
  }
  if (env.ENCRYPTION_KEY === "placeholder") warnings.push("ENCRYPTION_KEY is still the example placeholder value.");
  if (env.AUTH_SECRET === "set" && env.ENCRYPTION_KEY === "set" && !secretsConfigured()) {
    warnings.push("AUTH_SECRET and ENCRYPTION_KEY are identical — use two independent random values.");
  }
  if (env.DATABASE_URL === "missing") {
    warnings.push("DATABASE_URL is missing for this environment — check the Vercel variable scope (Production vs Preview).");
  }
  if (probe.error === "DATABASE_UNREACHABLE_TCP") {
    warnings.push("The database host resolves but the port is closed — the project is probably paused or firewalled.");
  }
  if (probe.error === "DATABASE_AUTH_FAILED") {
    warnings.push("The database rejected the credentials in DATABASE_URL.");
  }
  if (probe.error === "PRISMA_ENGINE_MISSING") {
    warnings.push("The Prisma engine does not match this platform — add binaryTargets and redeploy.");
  }
  if (probe.query === "ok" && !probe.schema) {
    warnings.push("The database is reachable but the tables are missing. Run: npx prisma migrate deploy");
  }
  if (process.env.NODE_ENV === "production" && appUrl.startsWith("http://")) {
    warnings.push(
      "APP_URL is http:// in production: session cookies are marked Secure and browsers will drop them over plain HTTP.",
    );
  }

  const ok =
    probe.query === "ok" && probe.schema && env.AUTH_SECRET === "set" && env.ENCRYPTION_KEY === "set";

  if (cookie.sameSite === "lax" && process.env.COOKIE_SAMESITE?.toLowerCase() === "none") {
    warnings.push("COOKIE_SAMESITE=none was requested but this deployment is not HTTPS; using lax.");
  }

  return NextResponse.json(
    {
      ok,
      service: "darknote-nexus",
      env,
      database: {
        ...probe,
        sessions,
      },
      warnings,
      // Public by design: these are the deployment's own hosts and flags, not secrets.
      cors: {
        sameOriginOnly: allowedOrigins.length === 0,
        allowedOrigins,
        frameAncestors: process.env.FRAME_ANCESTORS?.trim() || "'self'",
      },
      cookies: {
        name: "dnx_session",
        httpOnly: true,
        sameSite: cookie.sameSite,
        secure: cookie.secure,
      },
      runtime: {
        node: process.version,
        env: process.env.NODE_ENV ?? "unknown",
        region: process.env.VERCEL_REGION ?? null,
      },
      /**
       * Which build answered this request. Without it there is no way to tell
       * "the variable is missing" from "this is the deployment that was built
       * before the variable existed" — the single most common cause of a
       * correct-looking configuration still reading as empty.
       */
      deployment: {
        commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ?? null,
        id: process.env.VERCEL_DEPLOYMENT_ID ?? null,
        target: process.env.VERCEL_TARGET_ENV ?? process.env.VERCEL_ENV ?? null,
        branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
        host: process.env.VERCEL_URL ?? null,
      },
      secrets: {
        // Presence only. Two independent values are required.
        bothPresent: env.AUTH_SECRET === "set" && env.ENCRYPTION_KEY === "set",
        distinct: secretsConfigured(),
        /**
         * Which accepted name the runtime actually resolved, and every name it
         * looked for. Names only — no values, prefixes or lengths. This is the
         * difference between "not configured" and "configured as NEXTAUTH_SECRET".
         */
        sources,
      },
      at: new Date().toISOString(),
    },
    {
      status: ok ? 200 : 503,
      headers: { "Cache-Control": "no-store, max-age=0" },
    },
  );
}
