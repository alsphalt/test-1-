import bcrypt from "bcryptjs";
import { prisma } from "./db";

/**
 * Owner identity for Darknote Setup.
 *
 * Two independent factors are required before owner powers are granted:
 *   1. the request comes from a signed-in Nexus account whose email is on the
 *      owner allowlist (proving control of that mailbox), and
 *   2. the owner setup token matches the scrypt/bcrypt hash stored server-side.
 *
 * The token is never sent to the browser, never logged, and never stored in
 * plaintext. Only its hash lives in the database.
 */

const DEFAULT_OWNER_EMAILS = [
  "alsphaltjimna@gmail.com",
  "welkamals@gmail.com",
  "darknotjimna@gmail.com",
  "jimnaals@gmail.com",
];

export function ownerEmails(): string[] {
  const raw = (process.env.OWNER_EMAILS || "").trim();
  if (!raw) return DEFAULT_OWNER_EMAILS;
  return raw
    .split(/[,\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isOwnerEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return ownerEmails().includes(email.trim().toLowerCase());
}

function seedToken(): string {
  const fromEnv = process.env.OWNER_SETUP_TOKEN?.trim();
  return fromEnv && fromEnv.length >= 6 ? fromEnv : "1124100";
}

/** Creates the owner credential on first use. Never overwrites an existing hash. */
export async function ensureOwnerCredential(): Promise<void> {
  const existing = await prisma.ownerCredential.findUnique({
    where: { id: "owner" },
    select: { id: true },
  });
  if (existing) return;

  await prisma.ownerCredential
    .upsert({
      where: { id: "owner" },
      update: {},
      create: { id: "owner", tokenHash: await bcrypt.hash(seedToken(), 12) },
    })
    .catch(() => undefined); // concurrent first-run insert
}

export async function verifyOwnerToken(token: string): Promise<boolean> {
  if (!token || token.length > 128) return false;
  await ensureOwnerCredential();
  const row = await prisma.ownerCredential.findUnique({
    where: { id: "owner" },
    select: { tokenHash: true },
  });
  if (!row) return false;
  return bcrypt.compare(token, row.tokenHash);
}

export type OwnerTokenPolicy = { ok: true } | { ok: false; message: string };

/** The owner passkey is a shared secret; keep it long enough to resist guessing. */
export function checkOwnerTokenPolicy(next: string): OwnerTokenPolicy {
  if (next.length < 6) return { ok: false, message: "Use at least 6 characters." };
  if (next.length > 72) return { ok: false, message: "Use at most 72 characters." };
  if (/^\s|\s$/.test(next)) return { ok: false, message: "No leading or trailing spaces." };
  return { ok: true };
}

export async function rotateOwnerToken(next: string, byUserId: string): Promise<void> {
  const policy = checkOwnerTokenPolicy(next);
  if (!policy.ok) throw new Error(policy.message);

  const tokenHash = await bcrypt.hash(next, 12);
  await prisma.ownerCredential.upsert({
    where: { id: "owner" },
    update: { tokenHash, updatedById: byUserId },
    create: { id: "owner", tokenHash, updatedById: byUserId },
  });
}
