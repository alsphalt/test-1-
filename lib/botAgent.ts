import { prisma } from "./db";
import { sha256 } from "./auth";
import { forbidden, unauthorized } from "./http";
import type { WaStatus } from "./whatsapp";

export type BotIdentity = { id: string; userId: string; name: string; enabled: boolean };

/**
 * Machine authentication for an external bot agent.
 * `Authorization: Bearer dnx_…` — the token is only ever stored as a SHA-256 hash.
 */
export async function requireBot(req: Request): Promise<BotIdentity> {
  const header = req.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token.startsWith("dnx_")) throw unauthorized("Missing bot token");

  const bot = await prisma.bot.findUnique({
    where: { tokenHash: sha256(token) },
    select: { id: true, userId: true, name: true, enabled: true },
  });
  if (!bot) throw unauthorized("Unknown or revoked bot token");
  if (!bot.enabled) throw forbidden("This bot is disabled by its owner");
  return bot;
}

const ALIASES: Record<string, WaStatus> = {
  connected: "CONNECTED",
  open: "CONNECTED",
  online: "CONNECTED",
  pairing: "PAIRING_CODE",
  qr_pending: "PAIRING_CODE",
  code: "PAIRING_CODE",
  connecting: "CONNECTING",
  disconnected: "DISCONNECTED",
  close: "DISCONNECTED",
  offline: "DISCONNECTED",
  logged_out: "LOGGED_OUT",
  logout: "LOGGED_OUT",
  removed: "LOGGED_OUT",
  error: "ERROR",
};

/** Bots report either canonical statuses or their own spellings. */
export function normalizeStatus(input: string): WaStatus {
  const raw = (input || "").trim();
  const upper = raw.toUpperCase().replace(/[\s-]+/g, "_");
  const known: WaStatus[] = [
    "PAIRING_REQUESTED",
    "PAIRING_CODE",
    "CONNECTING",
    "CONNECTED",
    "DISCONNECTED",
    "RECONNECT_REQUESTED",
    "LOGGED_OUT",
    "ERROR",
  ];
  if (known.includes(upper as WaStatus)) return upper as WaStatus;
  return ALIASES[raw.toLowerCase()] || "ERROR";
}

export function digits(value: string | undefined | null): string {
  return (value || "").replace(/[^\d]/g, "").replace(/^0+/, "");
}
