import { prisma } from "@/lib/db";
import { subscribe } from "@/lib/events";
import { currentUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Longest a single stream is held open (Vercel caps function duration). */
const MAX_STREAM_MS = 55_000;
const POLL_MS = 4_000;

/**
 * Server-Sent Events stream scoped to the signed-in user.
 *
 * Two sources feed it:
 *  1. an in-process bus (instant when publisher and subscriber share an instance), and
 *  2. a database revision poll (works when publisher and subscriber land on
 *     different serverless instances, e.g. a bot heartbeat hitting another lambda).
 * Clients refetch their view on every `sync` event.
 */
export async function GET(req: Request) {
  const me = await currentUser();
  if (!me) {
    return new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Sign in first" } }), {
      status: 401,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  const encoder = new TextEncoder();
  let closed = false;
  let unsubscribe: (() => void) | null = null;
  let poller: ReturnType<typeof setInterval> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let lifetime: ReturnType<typeof setTimeout> | null = null;

  const revision = async (): Promise<string> => {
    const [bots, logs, files, integrations] = await Promise.all([
      prisma.bot.aggregate({ where: { userId: me.id }, _max: { updatedAt: true } }),
      prisma.botLog.count({ where: { bot: { userId: me.id } } }),
      prisma.fileAsset.count({ where: { userId: me.id } }),
      prisma.integration.aggregate({ where: { userId: me.id }, _max: { lastTestAt: true }, _count: true }),
    ]);
    return [
      bots._max.updatedAt?.getTime() ?? 0,
      logs,
      files,
      integrations._count ?? 0,
      integrations._max.lastTestAt?.getTime() ?? 0,
    ].join(":");
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const cleanup = () => {
        closed = true;
        if (poller) clearInterval(poller);
        if (heartbeat) clearInterval(heartbeat);
        if (lifetime) clearTimeout(lifetime);
        unsubscribe?.();
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

      write("retry: 3000\n\n");
      send({ type: "ready", at: Date.now(), payload: { userId: me.id } });

      unsubscribe = subscribe(me.id, (event) => send(event));

      let last = await revision();
      let polling = false;
      poller = setInterval(async () => {
        if (closed || polling) return;
        polling = true;
        try {
          const next = await revision();
          if (next !== last) {
            last = next;
            send({ type: "sync", at: Date.now(), payload: { rev: next } });
          }
        } catch {
          /* transient DB error — try again next tick */
        } finally {
          polling = false;
        }
      }, POLL_MS);

      heartbeat = setInterval(() => write(": keep-alive\n\n"), 15_000);

      lifetime = setTimeout(() => {
        send({ type: "bye", at: Date.now(), payload: {} });
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
      unsubscribe?.();
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
