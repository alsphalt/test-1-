import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { probeDatabase } from "@/lib/dbprobe";

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
  const authSecret = process.env.AUTH_SECRET?.trim() ?? "";
  const appUrl = process.env.APP_URL ?? "";

  const env = {
    AUTH_SECRET: !authSecret ? "missing" : authSecret.length < 32 ? "too_short" : "set",
    ENCRYPTION_KEY: presence(process.env.ENCRYPTION_KEY),
    DATABASE_URL: presence(process.env.DATABASE_URL),
    DIRECT_URL: presence(process.env.DIRECT_URL),
    APP_URL: presence(process.env.APP_URL),
    ADMIN_EMAILS: presence(process.env.ADMIN_EMAILS),
    OWNER_EMAILS: presence(process.env.OWNER_EMAILS),
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
  if (env.AUTH_SECRET === "missing") warnings.push("AUTH_SECRET is missing — signing in cannot work.");
  if (env.AUTH_SECRET === "too_short") warnings.push("AUTH_SECRET is shorter than 32 characters.");
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

  const ok = probe.query === "ok" && probe.schema && env.AUTH_SECRET === "set";

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
      runtime: {
        node: process.version,
        env: process.env.NODE_ENV ?? "unknown",
        region: process.env.VERCEL_REGION ?? null,
      },
      at: new Date().toISOString(),
    },
    {
      status: ok ? 200 : 503,
      headers: { "Cache-Control": "no-store, max-age=0" },
    },
  );
}
