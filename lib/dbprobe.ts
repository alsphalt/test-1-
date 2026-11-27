import "server-only";
import { promises as dns } from "node:dns";
import net from "node:net";
import { prisma } from "./db";
import { diagnose } from "./errors";

/**
 * Staged database reachability probe.
 *
 * "Cannot reach the database" covers four very different problems. This tells
 * them apart without exposing credentials:
 *   dns   → the hostname does not resolve (wrong host, typo, DNS outage)
 *   tcp   → resolves but the port is closed/blocked (paused project, firewall)
 *   query → the socket opens but auth/TLS/database name is wrong
 *   schema→ connected, but the tables are missing
 */

export type DbProbe = {
  driver: "postgresql" | "sqlite" | "unknown";
  host: string | null;
  port: number | null;
  credentials: "set" | "missing";
  dns: "ok" | "fail" | "skipped";
  tcp: "ok" | "fail" | "skipped";
  query: "ok" | "fail";
  schema: boolean;
  accounts: number | null;
  error?: string;
  hint?: string;
};

function maskHost(host: string): string {
  const [first, ...rest] = host.split(".");
  const maskedFirst = first.length <= 3 ? `${first[0] ?? ""}***` : `${first.slice(0, 3)}***`;
  return [maskedFirst, ...rest].join(".");
}

function parseUrl(raw: string | undefined): { driver: DbProbe["driver"]; host: string | null; port: number | null; credentials: "set" | "missing" } {
  if (!raw) return { driver: "unknown", host: null, port: null, credentials: "missing" };

  if (raw.startsWith("file:") || raw.startsWith(":memory:")) {
    return { driver: "sqlite", host: null, port: null, credentials: "missing" };
  }

  try {
    const url = new URL(raw);
    const driver = url.protocol === "postgresql:" || url.protocol === "postgres:" ? "postgresql" : "unknown";
    return {
      driver,
      host: url.hostname || null,
      port: url.port ? Number(url.port) : 5432,
      credentials: url.username ? "set" : "missing",
    };
  } catch {
    return { driver: "unknown", host: null, port: null, credentials: "missing" };
  }
}

async function lookup(host: string): Promise<boolean> {
  try {
    await Promise.race([
      dns.lookup(host),
      new Promise((_, reject) => setTimeout(() => reject(new Error("dns timeout")), 3000)),
    ]);
    return true;
  } catch {
    return false;
  }
}

function connect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(4000);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

export async function probeDatabase(): Promise<DbProbe> {
  const raw = process.env.DATABASE_URL?.trim();
  const parsed = parseUrl(raw);

  const probe: DbProbe = {
    driver: parsed.driver,
    host: parsed.host ? maskHost(parsed.host) : null,
    port: parsed.port,
    credentials: parsed.credentials,
    dns: "skipped",
    tcp: "skipped",
    query: "fail",
    schema: false,
    accounts: null,
  };

  if (!raw) {
    probe.error = "DATABASE_URL_MISSING";
    probe.hint = "DATABASE_URL is not set for this environment (check the Vercel environment scope: Production/Preview).";
    return probe;
  }

  if (parsed.driver === "postgresql" && parsed.host && parsed.port) {
    probe.dns = (await lookup(parsed.host)) ? "ok" : "fail";
    if (probe.dns !== "ok") {
      probe.error = "DATABASE_DNS_FAILED";
      probe.hint = "The database hostname does not resolve. Check the host in DATABASE_URL.";
      return probe;
    }

    probe.tcp = (await connect(parsed.host, parsed.port)) ? "ok" : "fail";
    if (probe.tcp !== "ok") {
      probe.error = "DATABASE_UNREACHABLE_TCP";
      probe.hint =
        "The hostname resolves but the port is closed. A paused Neon/Supabase project, an IP allowlist, or a stopped database produces this.";
      return probe;
    }
  }

  try {
    await prisma.$queryRaw`SELECT 1`;
    probe.query = "ok";
  } catch (err) {
    const d = diagnose(err);
    probe.error = d.code;
    probe.hint = d.hint ?? d.message;
    return probe;
  }

  try {
    probe.accounts = await prisma.user.count();
    probe.schema = true;
  } catch (err) {
    const d = diagnose(err);
    probe.error = d.code;
    probe.hint = d.hint ?? d.message;
  }

  return probe;
}
