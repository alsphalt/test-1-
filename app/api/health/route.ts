import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { diagnose } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Deployment diagnostics. Safe to expose: it reports whether configuration is
 * present and whether the database answers — never the values, connection
 * strings, credentials or user data.
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

  const database: {
    reachable: boolean;
    schema: boolean;
    accounts: number | null;
    sessions: number | null;
    error?: string;
    hint?: string;
  } = { reachable: false, schema: false, accounts: null, sessions: null };

  try {
    await prisma.$queryRaw`SELECT 1`;
    database.reachable = true;
  } catch (err) {
    const d = diagnose(err);
    database.error = d.code;
    database.hint = d.hint ?? d.message;
  }

  if (database.reachable) {
    try {
      database.accounts = await prisma.user.count();
      database.schema = true;
    } catch (err) {
      const d = diagnose(err);
      database.schema = false;
      database.error = d.code;
      database.hint = d.hint ?? d.message;
    }

    if (database.schema) {
      try {
        database.sessions = await prisma.session.count({
          where: { revokedAt: null, expiresAt: { gt: new Date() } },
        });
      } catch {
        /* counts are advisory only */
      }
    }
  }

  const warnings: string[] = [];
  if (process.env.NODE_ENV === "production" && appUrl.startsWith("http://")) {
    warnings.push(
      "APP_URL is http:// in production: session cookies are marked Secure and browsers will drop them over plain HTTP.",
    );
  }
  if (env.AUTH_SECRET === "missing") warnings.push("AUTH_SECRET is missing — signing in cannot work.");
  if (env.AUTH_SECRET === "too_short") warnings.push("AUTH_SECRET is shorter than 32 characters.");
  if (!database.reachable) warnings.push("The database is not reachable from this deployment.");
  if (database.reachable && !database.schema) {
    warnings.push("The database is reachable but the tables are missing. Run: npx prisma migrate deploy");
  }

  const ok = database.reachable && database.schema && env.AUTH_SECRET === "set";

  return NextResponse.json(
    {
      ok,
      service: "darknote-nexus",
      env,
      database,
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
