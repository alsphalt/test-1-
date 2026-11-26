import { prisma } from "@/lib/db";
import { sha256 } from "@/lib/auth";
import { publish } from "@/lib/events";
import {
  ApiError,
  assertSameOrigin,
  clientIp,
  forbidden,
  json,
  rateLimit,
  readJson,
  route,
  unauthorized,
} from "@/lib/http";
import { heartbeatSchema } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Machine-to-machine endpoint. Authenticated with `Authorization: Bearer dnx_…`
 * (the token returned once by /api/bots/pair). No cookie, no CSRF surface.
 */
export const POST = route(async (req: Request) => {
  assertSameOrigin(req);

  const header = req.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token.startsWith("dnx_")) throw unauthorized("Missing bot token");

  const ip = clientIp(req);
  rateLimit(`heartbeat:${sha256(token).slice(0, 16)}`, 240, 60_000);

  const bot = await prisma.bot.findUnique({
    where: { tokenHash: sha256(token) },
    select: { id: true, userId: true, enabled: true, status: true },
  });
  if (!bot) throw unauthorized("Unknown or revoked bot token");

  if (!bot.enabled) {
    await prisma.bot.update({ where: { id: bot.id }, data: { status: "PAUSED", lastSeenAt: new Date() } });
    throw forbidden("This bot is disabled by its owner");
  }

  const input = heartbeatSchema.parse(await readJson<unknown>(req).catch(() => ({})));
  const now = new Date();

  const updated = await prisma.bot.update({
    where: { id: bot.id },
    data: {
      status: input.status,
      lastSeenAt: now,
      ...(input.version ? { version: input.version } : {}),
      ...(input.messagesSent !== undefined ? { messagesSent: input.messagesSent } : {}),
      ...(input.errors !== undefined ? { errors: input.errors } : {}),
      ...(input.status === "OFFLINE" ? {} : {}),
    },
    select: { id: true, name: true, status: true, lastSeenAt: true },
  });

  await prisma.botLog.create({
    data: {
      botId: bot.id,
      level: input.status === "ERROR" ? "ERROR" : "INFO",
      message: input.message?.slice(0, 500) || `heartbeat (${input.status.toLowerCase()})`,
      meta: JSON.stringify({ ip, version: input.version || "", status: input.status }),
    },
  });

  publish(bot.userId, "bot.updated", {
    id: bot.id,
    status: updated.status,
    lastSeenAt: updated.lastSeenAt,
  });

  return json({ ok: true, bot: updated, serverTime: now.toISOString() });
});

export const GET = route(async () => {
  throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use POST with a Bearer token.");
});
