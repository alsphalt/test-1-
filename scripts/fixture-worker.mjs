/**
 * Local UI fixture: runs the real worker loop against the real database with a
 * stubbed WhatsApp socket. It never contacts WhatsApp.
 *
 *   DATABASE_URL=… node scripts/fixture-worker.mjs
 *
 * Use it to exercise the dashboard end to end without linking a real number.
 * For production use `node worker/index.mjs` (real Baileys sockets).
 */
import { PrismaClient } from "@prisma/client";
import { createWorker } from "../worker/index.mjs";

const prisma = new PrismaClient();
const calls = new Map();

function fakeSocket(state) {
  const handlers = new Map();
  const entry = { codes: 0, timer: null };
  const sock = {
    user: { id: "447700900123:7@s.whatsapp.net", platform: "smba" },
    authState: { creds: state.creds },
    ev: {
      on: (name, fn) => {
        const list = handlers.get(name) || [];
        list.push(fn);
        handlers.set(name, list);
      },
    },
    requestPairingCode: async () => {
      entry.codes += 1;
      const code = `DNX${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
      // Simulate the phone approving the code ~25s later.
      clearTimeout(entry.timer);
      entry.timer = setTimeout(async () => {
        state.creds.registered = true;
        for (const fn of handlers.get("creds.update") || []) await fn({});
        for (const fn of handlers.get("connection.update") || []) await fn({ connection: "open" });
      }, 25_000);
      return code;
    },
    end: () => clearTimeout(entry.timer),
    logout: async () => clearTimeout(entry.timer),
  };
  return sock;
}

const worker = createWorker({
  prisma,
  makeSocket: (state) => {
    const sock = fakeSocket(state);
    calls.set(sock, true);
    return sock;
  },
  workerId: "fixture-worker",
});

console.log("[fixture] worker loop started (stub transport, no WhatsApp traffic)");
await worker.reconcile();
setInterval(() => worker.reconcile().catch(() => undefined), 3_000);
setInterval(() => worker.heartbeat().catch(() => undefined), 15_000);

const stop = async () => {
  await worker.shutdown();
  await prisma.$disconnect();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
