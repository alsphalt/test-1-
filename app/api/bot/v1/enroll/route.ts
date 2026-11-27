import crypto from "crypto";
import { prisma } from "@/lib/db";
import { createBotToken } from "@/lib/auth";
import { assertSameOrigin, clientIp, json, rateLimit, readJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { ownerEmail?: string; name?: string };

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * Zero-touch agent enrolment.
 *
 * A bot host that holds BOT_ENROLL_SECRET (the same value configured here) can
 * register itself and receive its own token, instead of the owner copying a
 * pairing code into the bot's .env. Off unless the website sets the secret.
 */
export async function POST(req: Request) {
  assertSameOrigin(req);

  const secret = (process.env.BOT_ENROLL_SECRET || "").trim();
  if (!secret) {
    return json(
      {
        error: {
          code: "ENROLL_DISABLED",
          message:
            "Self-enrolment is off. Set BOT_ENROLL_SECRET on the website, or link this bot with a pairing code.",
        },
      },
      503,
    );
  }

  const provided = (req.headers.get("x-enroll-secret") || "").trim();
  if (!provided || !safeEqual(secret, provided)) {
    return json({ error: { code: "BAD_ENROLL_SECRET", message: "Enrolment secret rejected." } }, 401);
  }

  rateLimit(`enroll:${clientIp(req)}`, 20, 60 * 60_000);

  const body = await readJson<Body>(req).catch(() => ({}) as Body);
  const email = (body.ownerEmail || "").trim().toLowerCase();
  if (!email) {
    return json({ error: { code: "OWNER_REQUIRED", message: "ownerEmail is required." } }, 422);
  }

  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, status: true } });
  if (!user) {
    return json(
      {
        error: {
          code: "OWNER_NOT_FOUND",
          message: `No account exists for ${email}. Sign up on the site first, then start the bot.`,
        },
      },
      404,
    );
  }
  if (user.status === "SUSPENDED") {
    return json({ error: { code: "OWNER_SUSPENDED", message: "That account is suspended." } }, 403);
  }

  const name = (body.name || "bigbrother-bot").slice(0, 60);
  const existing = await prisma.bot.findFirst({
    where: { userId: user.id, name },
    select: { id: true },
  });

  const { token, hash, prefix } = createBotToken();
  const now = new Date();

  const bot = existing
    ? await prisma.bot.update({
        where: { id: existing.id },
        data: { tokenHash: hash, tokenPrefix: prefix, pairedAt: now, enabled: true, status: "OFFLINE", lastSeenAt: null },
        select: { id: true, name: true },
      })
    : await prisma.bot.create({
        data: {
          userId: user.id,
          name,
          description: "Self-enrolled agent",
          tokenHash: hash,
          tokenPrefix: prefix,
          pairedAt: now,
          enabled: true,
        },
        select: { id: true, name: true },
      });

  await prisma.botLog.create({
    data: { botId: bot.id, level: "INFO", message: "Agent enrolled itself", meta: JSON.stringify({ ip: clientIp(req) }) },
  });

  return json({ ok: true, botId: bot.id, name: bot.name, token });
}
