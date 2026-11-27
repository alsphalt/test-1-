import { prisma } from "@/lib/db";
import { requireBot } from "@/lib/botAgent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_STREAM_MS = 55_000;
const POLL_MS = 1_500;

/**
 * Bot ⇄ website event stream.
 *
 * The bot holds this connection (it runs on its own host, so a long-lived
 * request is fine). Every change the website makes on the owner's behalf —
 * a new pairing request, a restart, an unlink — bumps the revision below and
 * is pushed within ~1.5s, so pairing never waits for the next poll tick.
 *
 * Serverless note: the stream is capped at 55s and the bot reconnects
 * immediately; the revision is read from Postgres, so it also works when the
 * API call that queued the work landed on a different instance.
 */
export async function GET(req: Request) {
  // Not wrapped by route(): translate auth failures into JSON instead of a 500.
  let bot;
  try {
    bot = await requireBot(req);
  } catch (error) {
    const err = error as { status?: number; code?: string; message?: string };
    return Response.json(
      { error: { code: err.code || "UNAUTHORIZED", message: err.message || "Unauthorized", details: null } },
      { status: err.status || 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const encoder = new TextEncoder();
  let closed = false;
  let poller: ReturnType<typeof setInterval> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let lifetime: ReturnType<typeof setTimeout> | null = null;

  const revision = async (): Promise<string> => {
    const [sessions, pending, commands] = await Promise.all([
      prisma.whatsAppSession.aggregate({
        where: { botId: bot.id },
        _max: { updatedAt: true },
        _count: true,
      }),
      prisma.whatsAppSession.count({ where: { botId: bot.id, status: "PAIRING_REQUESTED" } }),
      prisma.botCommand.aggregate({
        where: { botId: bot.id, status: "PENDING" },
        _max: { createdAt: true },
        _count: true,
      }),
    ]);
    return [
      sessions._max.updatedAt?.getTime() ?? 0,
      sessions._count ?? 0,
      pending,
      commands._max.createdAt?.getTime() ?? 0,
      commands._count ?? 0,
    ].join(":");
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const cleanup = () => {
        closed = true;
        if (poller) clearInterval(poller);
        if (heartbeat) clearInterval(heartbeat);
        if (lifetime) clearTimeout(lifetime);
      };

      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };
      const send = (data: unknown) => write(`data: ${JSON.stringify(data)}\n\n`);

      write("retry: 2000\n\n");
      send({ type: "ready", at: Date.now(), bot: bot.id });

      let last = await revision();
      let busy = false;
      poller = setInterval(async () => {
        if (closed || busy) return;
        busy = true;
        try {
          const next = await revision();
          if (next !== last) {
            last = next;
            const [pending, commands] = await Promise.all([
              prisma.whatsAppSession.findMany({
                where: { botId: bot.id, status: "PAIRING_REQUESTED" },
                orderBy: { pairRequestedAt: "asc" },
                take: 10,
                select: { id: true, phone: true, label: true },
              }),
              prisma.botCommand.findMany({
                where: { botId: bot.id, status: "PENDING" },
                orderBy: { createdAt: "asc" },
                take: 10,
                select: { id: true, type: true, sessionId: true },
              }),
            ]);

            if (pending.length) send({ type: "pairing", at: Date.now(), requests: pending });
            if (commands.length) send({ type: "command", at: Date.now(), commands });
            send({ type: "sync", at: Date.now(), rev: next });
          }
        } catch {
          /* transient database error — next tick retries */
        } finally {
          busy = false;
        }
      }, POLL_MS);

      heartbeat = setInterval(() => write(": keep-alive\n\n"), 15_000);

      lifetime = setTimeout(() => {
        send({ type: "bye", at: Date.now() });
        cleanup();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }, MAX_STREAM_MS);

      req.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      closed = true;
      if (poller) clearInterval(poller);
      if (heartbeat) clearInterval(heartbeat);
      if (lifetime) clearTimeout(lifetime);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
