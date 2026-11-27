import { createHash, randomBytes, randomInt, randomUUID } from "crypto";
import { cookies } from "next/headers";
import bcrypt from "bcryptjs";
import { prisma } from "./db";
import { isProd } from "./env";
import { hashPassword, verifyPassword } from "./auth";
import { audit } from "./audit";
import { ApiError, badRequest, conflict, forbidden, notFound } from "./http";
import { isOwnerEmail, verifyOwnerToken } from "./owner";
import { requireUser, type AuthUser } from "./session";

/**
 * Darknote Setup access control.
 *
 * A separate authorization layer from the main Nexus login:
 *   - the main account proves who you are (existing session cookie),
 *   - a personal setup code (or the owner token) proves you may enter Setup.
 *
 * Setup sessions are server-side rows so revocation is immediate, and they are
 * intentionally independent from WhatsApp sessions: locking or signing out of
 * Setup never touches a paired bot.
 */

export const SETUP_COOKIE = "dnx_setup";

const OWNER_TTL_MS = 4 * 60 * 60 * 1000; // absolute owner session lifetime
const USER_TTL_MS = 8 * 60 * 60 * 1000;
const IDLE_MS = Number(process.env.SETUP_IDLE_MINUTES || 20) * 60 * 1000;
const CODE_TTL_HOURS = Number(process.env.SETUP_CODE_TTL_HOURS || 72);
const MAX_FAILED = 5;
const LOCK_MS = 15 * 60 * 1000;

export type SetupRole = "OWNER" | "USER";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateSetupCode(): string {
  let out = "";
  for (let i = 0; i < 8; i++) out += randomInt(0, 10).toString();
  return out;
}

export type PublicSetupAccount = {
  id: string;
  username: string;
  displayName: string;
  phone: string;
  status: string;
  codePrefix: string;
  codeExpiresAt: string;
  codeDelivery: string;
  codeDeliveryNote: string;
  linkedUserId: string | null;
  linkedEmail: string | null;
  createdAt: string;
  lastLoginAt: string | null;
  activatedAt: string | null;
};

type AccountWithUser = {
  id: string;
  username: string;
  displayName: string;
  phone: string;
  status: string;
  setupCodePrefix: string;
  setupCodeExpiresAt: Date;
  codeDelivery: string;
  codeDeliveryNote: string;
  userId: string | null;
  createdAt: Date;
  lastLoginAt: Date | null;
  activatedAt: Date | null;
};

export function publicAccount(row: AccountWithUser, linkedEmail: string | null = null): PublicSetupAccount {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    phone: row.phone,
    status: row.status,
    codePrefix: row.setupCodePrefix,
    codeExpiresAt: row.setupCodeExpiresAt.toISOString(),
    codeDelivery: row.codeDelivery,
    codeDeliveryNote: row.codeDeliveryNote,
    linkedUserId: row.userId,
    linkedEmail,
    createdAt: row.createdAt.toISOString(),
    lastLoginAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : null,
    activatedAt: row.activatedAt ? row.activatedAt.toISOString() : null,
  };
}

/* --------------------------------- sessions -------------------------------- */

export async function createSetupSession(input: {
  role: SetupRole;
  accountId?: string | null;
  ownerUserId?: string | null;
  ip?: string;
  userAgent?: string | null;
}): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const ttl = input.role === "OWNER" ? OWNER_TTL_MS : USER_TTL_MS;
  const expiresAt = new Date(Date.now() + ttl);

  await prisma.setupSession.create({
    data: {
      id: randomUUID(),
      role: input.role,
      setupAccountId: input.accountId ?? null,
      ownerUserId: input.ownerUserId ?? null,
      tokenHash: hashToken(token),
      ip: input.ip ?? "",
      userAgent: (input.userAgent ?? "").slice(0, 300),
      expiresAt,
    },
  });

  cookies().set({
    name: SETUP_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure: isProd(),
    path: "/",
    expires: expiresAt,
  });

  return { token, expiresAt };
}

export function clearSetupCookie(): void {
  cookies().set({
    name: SETUP_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: isProd(),
    path: "/",
    maxAge: 0,
  });
}

export type SetupContext = {
  sessionId: string;
  role: SetupRole;
  account: PublicSetupAccount | null;
};

/**
 * Resolves the Setup session AND binds it to the signed-in main account.
 * A session that belongs to somebody else, an account that was revoked, or one
 * that has been idle past the timeout is destroyed on the spot.
 */
export async function currentSetup(user: AuthUser): Promise<SetupContext | null> {
  const token = cookies().get(SETUP_COOKIE)?.value;
  if (!token) return null;

  const row = await prisma.setupSession.findUnique({
    where: { tokenHash: hashToken(token) },
    select: {
      id: true,
      role: true,
      setupAccountId: true,
      ownerUserId: true,
      lastSeenAt: true,
      expiresAt: true,
      revokedAt: true,
    },
  });
  if (!row || row.revokedAt) return null;

  const now = Date.now();
  const stale =
    row.expiresAt.getTime() < now || now - row.lastSeenAt.getTime() > IDLE_MS;

  const evict = async () => {
    await prisma.setupSession
      .update({ where: { id: row.id }, data: { revokedAt: new Date() } })
      .catch(() => undefined);
    clearSetupCookie();
  };

  if (stale) {
    await evict();
    return null;
  }

  if (row.role === "OWNER") {
    if (row.ownerUserId !== user.id || !isOwnerEmail(user.email)) {
      await evict();
      return null;
    }
    await touch(row.id, now);
    return { sessionId: row.id, role: "OWNER", account: null };
  }

  if (!row.setupAccountId) {
    await evict();
    return null;
  }

  const account = await prisma.setupAccount.findUnique({ where: { id: row.setupAccountId } });

  if (!account || account.status !== "ACTIVE" || account.userId !== user.id) {
    await evict();
    return null;
  }

  await touch(row.id, now);
  const linkedEmail = account.userId ? (await emailsFor([account.userId])).get(account.userId) ?? null : null;
  return { sessionId: row.id, role: "USER", account: publicAccount(account, linkedEmail) };
}

async function touch(sessionId: string, now: number) {
  await prisma.setupSession
    .update({ where: { id: sessionId }, data: { lastSeenAt: new Date(now) } })
    .catch(() => undefined);
}

export async function lockSetup(user: AuthUser): Promise<boolean> {
  const ctx = await currentSetup(user);
  if (!ctx) {
    clearSetupCookie();
    return false;
  }
  await prisma.setupSession.update({
    where: { id: ctx.sessionId },
    data: { revokedAt: new Date() },
  });
  clearSetupCookie();
  await audit({
    userId: user.id,
    action: "setup.lock",
    target: ctx.role,
    meta: { sessionId: ctx.sessionId },
  });
  return true;
}

export async function revokeAllSetupSessions(filter: {
  accountId?: string;
  ownerUserId?: string;
}): Promise<number> {
  const res = await prisma.setupSession.updateMany({
    where: {
      revokedAt: null,
      ...(filter.accountId ? { setupAccountId: filter.accountId } : {}),
      ...(filter.ownerUserId ? { ownerUserId: filter.ownerUserId } : {}),
    },
    data: { revokedAt: new Date() },
  });
  return res.count;
}


/** SetupAccount stores a plain userId; resolve linked emails in one query. */
async function emailsFor(userIds: (string | null)[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter((v): v is string => Boolean(v)))] as string[];
  if (ids.length === 0) return new Map();
  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, email: true },
  });
  return new Map(users.map((u) => [u.id, u.email]));
}

/* ----------------------------------- state ---------------------------------- */

export type SetupState = {
  ownerEligible: boolean;
  unlocked: boolean;
  role: SetupRole | null;
  needs: "owner_token" | "code" | "activation" | "approval" | "blocked" | "unlocked";
  account: PublicSetupAccount | null;
  ownerEmailsHint: string;
};

export async function setupState(user: AuthUser): Promise<SetupState> {
  const ctx = await currentSetup(user);
  const account = await prisma.setupAccount.findFirst({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
  });
  const linkedEmail = account?.userId ? (await emailsFor([account.userId])).get(account.userId) ?? null : null;
  const pub = account ? publicAccount(account, linkedEmail) : null;

  let needs: SetupState["needs"];
  if (ctx) needs = "unlocked";
  else if (isOwnerEmail(user.email)) needs = "owner_token";
  else if (!pub) needs = "activation";
  else if (pub.status === "ACTIVE") needs = "code";
  else if (pub.status === "PENDING") needs = "approval";
  else if (pub.status === "SUSPENDED" || pub.status === "REVOKED") needs = "blocked";
  else needs = "activation";

  return {
    ownerEligible: isOwnerEmail(user.email),
    unlocked: Boolean(ctx),
    role: ctx?.role ?? null,
    needs,
    account: pub,
    ownerEmailsHint: user.email.replace(/^(.).*(@.*)$/, "$1•••$2"),
  };
}

/* ----------------------------------- codes ---------------------------------- */

export async function issueCode(accountId: string): Promise<{ code: string; expiresAt: Date }> {
  const code = generateSetupCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_HOURS * 60 * 60 * 1000);

  await prisma.setupAccount.update({
    where: { id: accountId },
    data: {
      setupCodeHash: await bcrypt.hash(code, 10),
      setupCodePrefix: `${code.slice(0, 2)}••••${code.slice(-2)}`,
      setupCodeIssuedAt: new Date(),
      setupCodeExpiresAt: expiresAt,
      setupCodeUsedAt: null,
      failedAttempts: 0,
      lockedUntil: null,
      codeDelivery: "NOT_SENT",
      codeDeliveryNote: "",
    },
  });

  return { code, expiresAt };
}

async function verifyCode(
  account: { id: string; setupCodeHash: string; setupCodeExpiresAt: Date; lockedUntil: Date | null; failedAttempts: number },
  code: string,
): Promise<void> {
  const now = Date.now();

  if (account.lockedUntil && account.lockedUntil.getTime() > now) {
    throw new ApiError(
      423,
      "SETUP_LOCKED",
      "Too many incorrect codes. Try again later or ask the owner to reset your code.",
    );
  }

  if (account.setupCodeExpiresAt.getTime() < now) {
    throw new ApiError(
      410,
      "SETUP_CODE_EXPIRED",
      "This setup code has expired. Ask the owner to issue a new one.",
    );
  }

  const ok = await bcrypt.compare(code, account.setupCodeHash);
  if (!ok) {
    const failed = account.failedAttempts + 1;
    await prisma.setupAccount.update({
      where: { id: account.id },
      data: {
        failedAttempts: failed,
        lockedUntil: failed >= MAX_FAILED ? new Date(now + LOCK_MS) : null,
      },
    });
    throw forbidden("That setup code is not valid.");
  }

  if (account.failedAttempts !== 0 || account.lockedUntil) {
    await prisma.setupAccount.update({
      where: { id: account.id },
      data: { failedAttempts: 0, lockedUntil: null },
    });
  }
}

/* ---------------------------------- delivery --------------------------------- */

const CODE_MESSAGE = (username: string, code: string, hours: number) =>
  [
    "DARKNOTE NEXUS — SETUP ACCESS",
    "",
    `Username: ${username}`,
    `Setup code: ${code}`,
    `Expires: ${hours} hours`,
    "",
    "Sign in to the DARKNOTE NEXUS website, open Setup and enter this code.",
    "Never share this code. The owner can reset it at any time.",
  ].join("\n");

/**
 * Queues the code to the owner's own connected WhatsApp number.
 *
 * Delivery is performed by the Baileys worker (worker/index.mjs), which owns
 * the socket; the web process only enqueues. If no owner number is connected
 * the account records FAILED with the reason, and the owner can retry.
 */
export async function deliverCode(input: {
  accountId: string;
  username: string;
  phone: string;
  code: string;
}): Promise<{ queued: boolean; note: string }> {
  const phone = input.phone.replace(/[^\d]/g, "");
  const hours = CODE_TTL_HOURS;

  if (!phone) {
    const note = "No phone number on this account — share the code manually.";
    await markDelivery(input.accountId, "FAILED", note);
    return { queued: false, note };
  }

  const ownerSession = await prisma.whatsAppSession.findFirst({
    where: {
      status: "CONNECTED",
      user: { email: { in: ownerEmailList() } },
    },
    orderBy: { lastSeenAt: "desc" },
    select: { id: true, label: true, meNumber: true, phone: true },
  });

  if (!ownerSession) {
    const note =
      "No connected WhatsApp number is available to send from. Connect one under WhatsApp Sessions, then retry.";
    await markDelivery(input.accountId, "FAILED", note);
    return { queued: false, note };
  }

  await prisma.whatsAppOutbox.create({
    data: {
      sessionId: ownerSession.id,
      to: phone,
      body: CODE_MESSAGE(input.username, input.code, hours),
      purpose: `setup_code:${input.accountId}`,
    },
  });

  const note = `Queued to ${ownerSession.label || ownerSession.meNumber || "the connected number"}.`;
  await markDelivery(input.accountId, "QUEUED", note);
  return { queued: true, note };
}

function ownerEmailList(): string[] {
  // Local import to avoid pulling env parsing into the client bundle graph.
  const raw = (process.env.OWNER_EMAILS || "").trim();
  const value = raw
    ? raw.split(/[,\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean)
    : [
        "alsphaltjimna@gmail.com",
        "welkamals@gmail.com",
        "darknotjimna@gmail.com",
        "jimnaals@gmail.com",
      ];
  return value;
}

async function markDelivery(accountId: string, status: string, note: string) {
  await prisma.setupAccount
    .update({
      where: { id: accountId },
      data: { codeDelivery: status, codeDeliveryNote: note.slice(0, 300) },
    })
    .catch(() => undefined);
}

/* ---------------------------------- accounts --------------------------------- */

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;

export type CreatedAccount = { account: PublicSetupAccount; code: string; delivery: { queued: boolean; note: string } };

export async function createSetupAccount(
  input: {
    username: string;
    password: string;
    phone: string;
    displayName?: string;
    mainEmail?: string;
  },
  owner: AuthUser,
  meta: { ip?: string } = {},
): Promise<CreatedAccount> {
  const username = input.username.trim().toLowerCase();
  if (!USERNAME_RE.test(username)) {
    throw badRequest("Username must be 3–32 characters: letters, numbers, dot, dash or underscore.");
  }
  if (!/[a-zA-Z]/.test(input.password) || !/[0-9]/.test(input.password) || input.password.length < 10) {
    throw badRequest("Password must be at least 10 characters and include a letter and a number.");
  }

  const phone = normalizePhone(input.phone);
  if (!phone) throw badRequest("Enter a phone number with its country code, e.g. +254700000000.");

  const existing = await prisma.setupAccount.findUnique({ where: { username }, select: { id: true } });
  if (existing) throw conflict("That setup username is already taken.");

  let linkedUserId: string | null = null;
  let linkedEmail: string | null = null;
  if (input.mainEmail?.trim()) {
    const email = input.mainEmail.trim().toLowerCase();
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true } });
    if (!user) throw badRequest(`No Nexus account exists for ${email}. Ask them to register first, or leave it blank.`);
    const taken = await prisma.setupAccount.findFirst({ where: { userId: user.id }, select: { id: true } });
    if (taken) throw conflict("That Nexus account is already linked to a Setup account.");
    linkedUserId = user.id;
    linkedEmail = user.email;
  }

  const created = await prisma.setupAccount.create({
    data: {
      username,
      passwordHash: await hashPassword(input.password),
      phone,
      displayName: (input.displayName || "").trim().slice(0, 60),
      setupCodeHash: await bcrypt.hash(generateSetupCode(), 10), // replaced below
      setupCodeExpiresAt: new Date(Date.now() + CODE_TTL_HOURS * 3600_000),
      userId: linkedUserId,
      createdById: owner.id,
      status: "INVITED",
    },
  });

  const { code } = await issueCode(created.id);
  const delivery = await deliverCode({ accountId: created.id, username, phone, code });

  const fresh = await prisma.setupAccount.findUniqueOrThrow({ where: { id: created.id } });

  await audit({
    userId: owner.id,
    action: "setup.account_create",
    target: username,
    meta: { phone: maskPhone(phone), linked: linkedEmail, delivery: delivery.queued ? "queued" : "failed" },
    ip: meta.ip,
  });

  return { account: publicAccount(fresh, linkedEmail), code, delivery };
}

export function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim().replace(/[\s()-]/g, "");
  if (!/^\+?\d{7,15}$/.test(trimmed)) return null;
  return trimmed.startsWith("+") ? trimmed : `+${trimmed}`;
}

export function maskPhone(phone: string): string {
  if (phone.length < 5) return phone;
  return `${phone.slice(0, 4)}•••${phone.slice(-2)}`;
}

/* --------------------------------- activation -------------------------------- */

export async function activateSetup(input: {
  username: string;
  password: string;
  code: string;
  user: AuthUser;
  ip?: string;
}): Promise<{ status: "PENDING"; requestId: string }> {
  const account = await prisma.setupAccount.findUnique({
    where: { username: input.username.trim().toLowerCase() },
  });

  // Uniform response so the endpoint cannot be used to enumerate usernames.
  const mismatch = badRequest("Those credentials do not match an invitation.");
  if (!account) throw mismatch;

  if (account.status === "REVOKED" || account.status === "SUSPENDED") {
    throw forbidden("This Setup account is not active. Contact the owner.");
  }
  if (account.status === "ACTIVE") {
    throw conflict("This account is already active — just enter your setup code.");
  }
  if (account.userId && account.userId !== input.user.id) {
    throw conflict("This Setup account is already linked to another Nexus account.");
  }

  const passwordOk = await verifyPassword(input.password, account.passwordHash);
  if (!passwordOk) {
    await audit({
      userId: input.user.id,
      action: "setup.activation_failed",
      target: account.username,
      meta: { reason: "password" },
      ip: input.ip,
    });
    throw mismatch;
  }

  await verifyCode(account, input.code);

  const existingPending = await prisma.setupAccessRequest.findFirst({
    where: { setupAccountId: account.id, status: "PENDING" },
    select: { id: true },
  });

  const request =
    existingPending ??
    (await prisma.setupAccessRequest.create({
      data: { setupAccountId: account.id, userId: input.user.id },
      select: { id: true },
    }));

  await prisma.setupAccount.update({
    where: { id: account.id },
    data: {
      status: "PENDING",
      // Claim ownership now so the account cannot be taken over while pending;
      // access itself still requires the owner's approval.
      userId: account.userId ?? input.user.id,
      setupCodeUsedAt: new Date(),
    },
  });

  await audit({
    userId: input.user.id,
    action: "setup.request_create",
    target: account.username,
    meta: { requestId: request.id },
    ip: input.ip,
  });

  return { status: "PENDING", requestId: request.id };
}

export async function unlockWithCode(input: {
  user: AuthUser;
  code: string;
  ip?: string;
  userAgent?: string | null;
}): Promise<SetupContext> {
  const account = await prisma.setupAccount.findFirst({ where: { userId: input.user.id } });

  if (!account) throw forbidden("No Setup account is linked to this Nexus account.");
  if (account.status !== "ACTIVE") {
    throw forbidden(
      account.status === "PENDING"
        ? "Your Setup access is still waiting for owner approval."
        : "This Setup account is not active. Contact the owner.",
    );
  }

  await verifyCode(account, input.code);

  await createSetupSession({
    role: "USER",
    accountId: account.id,
    ip: input.ip,
    userAgent: input.userAgent,
  });

  await prisma.setupAccount.update({
    where: { id: account.id },
    data: { lastLoginAt: new Date(), setupCodeUsedAt: account.setupCodeUsedAt ?? new Date() },
  });

  await audit({
    userId: input.user.id,
    action: "setup.login",
    target: account.username,
    meta: { role: "USER" },
    ip: input.ip,
  });

  const linkedEmail = account.userId ? (await emailsFor([account.userId])).get(account.userId) ?? null : null;
  return { sessionId: "", role: "USER", account: publicAccount(account, linkedEmail) };
}

export async function unlockAsOwner(input: {
  user: AuthUser;
  token: string;
  ip?: string;
  userAgent?: string | null;
}): Promise<void> {
  if (!isOwnerEmail(input.user.email)) {
    await audit({
      userId: input.user.id,
      action: "setup.owner_denied",
      target: input.user.email,
      meta: { reason: "email_not_allowlisted" },
      ip: input.ip,
    });
    throw forbidden("This account is not an owner account.");
  }

  const ok = await verifyOwnerToken(input.token);
  if (!ok) {
    await audit({
      userId: input.user.id,
      action: "setup.owner_denied",
      target: input.user.email,
      meta: { reason: "bad_token" },
      ip: input.ip,
    });
    throw forbidden("The owner setup token is incorrect.");
  }

  await createSetupSession({
    role: "OWNER",
    ownerUserId: input.user.id,
    ip: input.ip,
    userAgent: input.userAgent,
  });

  await audit({
    userId: input.user.id,
    action: "setup.owner_login",
    target: input.user.email,
    ip: input.ip,
  });
}

/* --------------------------------- approvals --------------------------------- */

export async function listRequests(status = "PENDING") {
  const rows = await prisma.setupAccessRequest.findMany({
    where: status === "ALL" ? {} : { status },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { account: true },
  });

  const userIds = rows.map((r) => r.userId).filter((v): v is string => Boolean(v));
  const users = userIds.length
    ? await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, email: true, name: true },
      })
    : [];
  const userMap = new Map(users.map((u) => [u.id, u]));
  const emailMap = await emailsFor(rows.map((r) => r.account.userId));

  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    requestedBy: row.userId ? userMap.get(row.userId) ?? null : null,
    account: publicAccount(row.account, row.account.userId ? emailMap.get(row.account.userId) ?? null : null),
  }));
}

export async function decideRequest(input: {
  requestId: string;
  decision: "approve" | "reject";
  owner: AuthUser;
  ip?: string;
}): Promise<{ status: string }> {
  const request = await prisma.setupAccessRequest.findUnique({
    where: { id: input.requestId },
    include: { account: true },
  });
  if (!request) throw notFound("Access request not found.");
  if (request.status !== "PENDING") throw conflict("That request has already been decided.");

  if (input.decision === "reject") {
    await prisma.$transaction([
      prisma.setupAccessRequest.update({
        where: { id: request.id },
        data: { status: "REJECTED", decidedAt: new Date(), decidedById: input.owner.id },
      }),
      prisma.setupAccount.update({
        where: { id: request.setupAccountId },
        data: { status: "INVITED" },
      }),
      prisma.setupSession.updateMany({
        where: { setupAccountId: request.setupAccountId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    await audit({
      userId: input.owner.id,
      action: "setup.request_reject",
      target: request.account.username,
      meta: { requestId: request.id },
      ip: input.ip,
    });
    return { status: "REJECTED" };
  }

  // Approve: link to the requesting main account unless the owner pre-linked one.
  const linkTo = request.account.userId ?? request.userId;
  if (!linkTo) throw conflict("This request has no main Nexus account to link to.");

  if (request.account.userId && request.userId && request.account.userId !== request.userId) {
    throw conflict("This Setup account is linked to a different Nexus account.");
  }

  const alreadyLinked = await prisma.setupAccount.findFirst({
    where: { userId: linkTo, id: { not: request.setupAccountId } },
    select: { id: true },
  });
  if (alreadyLinked) throw conflict("That Nexus account already has a different Setup account.");

  await prisma.$transaction([
    prisma.setupAccessRequest.update({
      where: { id: request.id },
      data: { status: "APPROVED", decidedAt: new Date(), decidedById: input.owner.id },
    }),
    prisma.setupAccessRequest.updateMany({
      where: { setupAccountId: request.setupAccountId, status: "PENDING", id: { not: request.id } },
      data: { status: "REJECTED", decidedAt: new Date(), decidedById: input.owner.id },
    }),
    prisma.setupAccount.update({
      where: { id: request.setupAccountId },
      data: { status: "ACTIVE", userId: linkTo, activatedAt: new Date() },
    }),
  ]);

  await audit({
    userId: input.owner.id,
    action: "setup.request_approve",
    target: request.account.username,
    meta: { requestId: request.id, linkedTo: linkTo },
    ip: input.ip,
  });

  return { status: "APPROVED" };
}

/* ---------------------------------- actions ---------------------------------- */

export async function listAccounts(): Promise<PublicSetupAccount[]> {
  const rows = await prisma.setupAccount.findMany({ orderBy: { createdAt: "desc" } });
  const emailMap = await emailsFor(rows.map((r) => r.userId));
  return rows.map((row) => publicAccount(row, row.userId ? emailMap.get(row.userId) ?? null : null));
}

export async function resetAccountCode(accountId: string, owner: AuthUser, ip?: string) {
  const account = await prisma.setupAccount.findUnique({ where: { id: accountId } });
  if (!account) throw notFound("Setup account not found.");

  const { code, expiresAt } = await issueCode(account.id);
  await revokeAllSetupSessions({ accountId: account.id });

  const delivery = await deliverCode({
    accountId: account.id,
    username: account.username,
    phone: account.phone,
    code,
  });

  await audit({
    userId: owner.id,
    action: "setup.code_reset",
    target: account.username,
    meta: { delivery: delivery.queued ? "queued" : "failed" },
    ip,
  });

  return { code, expiresAt: expiresAt.toISOString(), delivery };
}

export async function setAccountStatus(
  accountId: string,
  status: "SUSPENDED" | "ACTIVE" | "REVOKED" | "INVITED",
  owner: AuthUser,
  ip?: string,
) {
  const account = await prisma.setupAccount.findUnique({ where: { id: accountId } });
  if (!account) throw notFound("Setup account not found.");

  await prisma.setupAccount.update({ where: { id: accountId }, data: { status } });
  if (status !== "ACTIVE") await revokeAllSetupSessions({ accountId });

  await audit({
    userId: owner.id,
    action: status === "SUSPENDED" ? "setup.account_suspend" : "setup.account_status",
    target: account.username,
    meta: { status },
    ip,
  });
}

export async function resetAccountPassword(
  accountId: string,
  password: string,
  owner: AuthUser,
  ip?: string,
) {
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password) || password.length < 10) {
    throw badRequest("Password must be at least 10 characters and include a letter and a number.");
  }
  const account = await prisma.setupAccount.findUnique({ where: { id: accountId } });
  if (!account) throw notFound("Setup account not found.");

  await prisma.setupAccount.update({
    where: { id: accountId },
    data: { passwordHash: await hashPassword(password), failedAttempts: 0, lockedUntil: null },
  });
  await revokeAllSetupSessions({ accountId });

  await audit({ userId: owner.id, action: "setup.password_reset", target: account.username, ip });
}

export async function unlinkAccount(accountId: string, owner: AuthUser, ip?: string) {
  const account = await prisma.setupAccount.findUnique({ where: { id: accountId } });
  if (!account) throw notFound("Setup account not found.");

  await prisma.setupAccount.update({ where: { id: accountId }, data: { userId: null } });
  await revokeAllSetupSessions({ accountId });

  await audit({ userId: owner.id, action: "setup.account_unlink", target: account.username, ip });
}

export async function deleteAccount(accountId: string, owner: AuthUser, ip?: string) {
  const account = await prisma.setupAccount.findUnique({ where: { id: accountId } });
  if (!account) throw notFound("Setup account not found.");

  await revokeAllSetupSessions({ accountId });
  await prisma.setupAccount.delete({ where: { id: accountId } });

  await audit({
    userId: owner.id,
    action: "setup.account_delete",
    target: account.username,
    meta: { phone: account.phone ? maskPhone(account.phone) : "" },
    ip,
  });
}


/** Owner-only guard for Setup administration: allowlisted email + unlocked Setup session. */
export async function requireOwnerSetup(): Promise<AuthUser> {
  const user = await requireUser();
  if (!isOwnerEmail(user.email)) throw forbidden("Owner access required.");
  const ctx = await currentSetup(user);
  if (!ctx || ctx.role !== "OWNER") {
    throw new ApiError(403, "SETUP_LOCKED", "Setup is locked. Verify the owner setup token.");
  }
  return user;
}

/** Any unlocked Setup session (owner or authorised user). */
export async function requireSetupSession(): Promise<{ user: AuthUser; context: SetupContext }> {
  const user = await requireUser();
  const context = await currentSetup(user);
  if (!context) throw new ApiError(403, "SETUP_LOCKED", "Setup is locked. Verify to continue.");
  return { user, context };
}

/* ---------------------------------- overview --------------------------------- */

export async function setupOverview() {
  const now = new Date();
  const onlineCutoff = new Date(now.getTime() - 120_000);
  const activeCutoff = new Date(now.getTime() - 15 * 60_000);

  const [
    totalBots,
    pairedBots,
    liveBots,
    activeSessions,
    activeUsers,
    waTotal,
    waConnected,
    setupTotal,
    setupActive,
    setupSuspended,
    pendingRequests,
    recentBots,
    recentDisconnected,
    recentAudit,
    sessionRows,
  ] = await Promise.all([
    prisma.bot.count(),
    prisma.bot.count({ where: { tokenHash: { not: null } } }),
    prisma.bot.count({ where: { status: "ONLINE", lastSeenAt: { gt: onlineCutoff } } }),
    prisma.session.count({ where: { revokedAt: null, expiresAt: { gt: now } } }),
    prisma.session.findMany({
      where: { revokedAt: null, expiresAt: { gt: now }, lastSeenAt: { gt: activeCutoff } },
      distinct: ["userId"],
      select: { userId: true },
    }),
    prisma.whatsAppSession.count(),
    prisma.whatsAppSession.count({ where: { status: "CONNECTED" } }),
    prisma.setupAccount.count(),
    prisma.setupAccount.count({ where: { status: "ACTIVE" } }),
    prisma.setupAccount.count({ where: { status: "SUSPENDED" } }),
    prisma.setupAccessRequest.count({ where: { status: "PENDING" } }),
    prisma.bot.findMany({
      where: { pairedAt: { not: null } },
      orderBy: { pairedAt: "desc" },
      take: 5,
      select: { id: true, name: true, status: true, pairedAt: true, lastSeenAt: true, user: { select: { email: true } } },
    }),
    prisma.whatsAppSession.findMany({
      where: { status: { in: ["DISCONNECTED", "LOGGED_OUT", "ERROR"] } },
      orderBy: { updatedAt: "desc" },
      take: 5,
      select: { id: true, label: true, phone: true, meNumber: true, status: true, updatedAt: true, user: { select: { email: true } } },
    }),
    prisma.auditLog.findMany({
      where: { action: { startsWith: "setup." } },
      orderBy: { createdAt: "desc" },
      take: 12,
      select: { id: true, action: true, target: true, createdAt: true, ip: true, user: { select: { email: true } } },
    }),
    prisma.session.findMany({
      where: { revokedAt: null, expiresAt: { gt: now } },
      orderBy: { lastSeenAt: "desc" },
      take: 8,
      select: { id: true, ip: true, userAgent: true, lastSeenAt: true, user: { select: { email: true } } },
    }),
  ]);

  return {
    generatedAt: now.toISOString(),
    bots: {
      total: totalBots,
      paired: pairedBots,
      connected: liveBots,
      disconnected: Math.max(0, pairedBots - liveBots),
    },
    whatsapp: {
      total: waTotal,
      connected: waConnected,
      disconnected: Math.max(0, waTotal - waConnected),
    },
    website: {
      activeSessions,
      activeUsers: activeUsers.length,
      sessions: sessionRows.map((s) => ({
        id: s.id,
        ip: s.ip,
        userAgent: s.userAgent,
        lastSeenAt: s.lastSeenAt.toISOString(),
        email: s.user.email,
      })),
    },
    setup: {
      total: setupTotal,
      active: setupActive,
      suspended: setupSuspended,
      pendingRequests,
    },
    recentBots: recentBots.map((b) => ({
      id: b.id,
      name: b.name,
      status: b.status,
      pairedAt: b.pairedAt ? b.pairedAt.toISOString() : null,
      lastSeenAt: b.lastSeenAt ? b.lastSeenAt.toISOString() : null,
      email: b.user.email,
    })),
    recentDisconnected: recentDisconnected.map((s) => ({
      id: s.id,
      label: s.label,
      number: s.meNumber || s.phone,
      status: s.status,
      at: s.updatedAt.toISOString(),
      email: s.user.email,
    })),
    audit: recentAudit.map((a) => ({
      id: a.id,
      action: a.action,
      target: a.target,
      at: a.createdAt.toISOString(),
      ip: a.ip,
      email: a.user?.email ?? null,
    })),
  };
}

export async function listSetupActivity(limit = 100) {
  const rows = await prisma.auditLog.findMany({
    where: { action: { startsWith: "setup." } },
    orderBy: { createdAt: "desc" },
    take: Math.min(300, Math.max(1, limit)),
    select: {
      id: true,
      action: true,
      target: true,
      meta: true,
      ip: true,
      createdAt: true,
      user: { select: { email: true } },
    },
  });

  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    target: r.target,
    meta: safeMeta(r.meta),
    ip: r.ip,
    at: r.createdAt.toISOString(),
    email: r.user?.email ?? null,
  }));
}

function safeMeta(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
