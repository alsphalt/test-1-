/**
 * Realtime fan-out.
 *
 * The default transport is an in-process event bus: it works perfectly for a
 * single Node instance (local dev, self-hosted, long-lived container) and for
 * the lifetime of a Vercel serverless instance. Whenever events must cross
 * instances, set UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN and the bus
 * transparently publishes through Redis pub/sub instead.
 */

export type NexusEvent = {
  type:
    | "note.created"
    | "note.updated"
    | "note.deleted"
    | "bot.updated"
    | "bot.log"
    | "bot.paired"
    | "file.created"
    | "file.deleted"
    | "integration.updated"
    | "user.updated"
    | "sync"
    | "ping";
  at: number;
  payload: Record<string, unknown>;
};

type Listener = (event: NexusEvent) => void;

const globalBus = globalThis as unknown as {
  __nexusSubs?: Map<string, Set<Listener>>;
};
const subs: Map<string, Set<Listener>> = (globalBus.__nexusSubs ??= new Map());

function localPublish(userId: string, event: NexusEvent) {
  const set = subs.get(userId);
  if (!set) return;
  for (const listener of set) {
    try {
      listener(event);
    } catch {
      /* a broken listener must never break the publisher */
    }
  }
}

export function subscribe(userId: string, listener: Listener): () => void {
  let set = subs.get(userId);
  if (!set) {
    set = new Set();
    subs.set(userId, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) subs.delete(userId);
  };
}

async function redisPublish(userId: string, event: NexusEvent) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return;
  try {
    await fetch(`${url}/publish/nexus:${userId}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(JSON.stringify(event)),
      cache: "no-store",
    });
  } catch {
    /* best-effort; SSE clients also poll as a safety net */
  }
}

export function publish(userId: string, type: NexusEvent["type"], payload: Record<string, unknown> = {}) {
  const event: NexusEvent = { type, at: Date.now(), payload };
  localPublish(userId, event);
  void redisPublish(userId, event);
  return event;
}
