#!/usr/bin/env node
/**
 * Darknote Nexus — WhatsApp worker.
 *
 * Holds the real Baileys sockets. The Next.js app never talks to WhatsApp: it
 * writes session rows, this worker claims them, asks WhatsApp for a genuine
 * pairing code, persists the encrypted auth state and keeps the socket alive.
 *
 *   DATABASE_URL=… ENCRYPTION_KEY=… node worker/index.mjs
 *
 * Must run on a long-lived host (Railway, Fly, Render, a VPS, Docker).
 * Serverless functions cannot keep a socket open.
 */
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";
import makeWASocket, {
  Browsers,
  BufferJSON,
  DisconnectReason,
  fetchLatestBaileysVersion,
  initAuthCreds,
  proto,
} from "@whiskeysockets/baileys";

const TICK_MS = 3_000;
const HEARTBEAT_MS = 15_000;
const MAINTENANCE_MS = 60 * 60_000;
const CODE_TTL_MS = 60_000;
const MAX_RETRIES = 6;
const STALE_MS = 90_000;
const WORKER_ID = process.env.WORKER_ID || `worker-${process.pid}`;

/* ------------------------------- encryption ------------------------------- */

function encryptionKey() {
  const raw = (process.env.ENCRYPTION_KEY || "").trim();
  if (!raw) {
    if (process.env.NODE_ENV === "production") throw new Error("ENCRYPTION_KEY is required");
    return Buffer.alloc(32, 0);
  }
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes (hex or base64)");
  return buf;
}

export function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString("base64url")).join(".");
}

export function decryptSecret(payload) {
  const [iv, tag, data] = String(payload).split(".");
  if (!iv || !tag || !data) throw new Error("Malformed ciphertext");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}

/* --------------------------- auth state in postgres ------------------------ */

export async function useDbAuthState(prisma, sessionId) {
  const read = async (keyId) => {
    const row = await prisma.whatsAppKey.findUnique({
      where: { sessionId_keyId: { sessionId, keyId } },
      select: { value: true },
    });
    if (!row) return null;
    try {
      return JSON.parse(decryptSecret(row.value), BufferJSON.reviver);
    } catch {
      return null;
    }
  };

  const write = async (keyId, value) => {
    const payload = encryptSecret(JSON.stringify(value, BufferJSON.replacer));
    await prisma.whatsAppKey.upsert({
      where: { sessionId_keyId: { sessionId, keyId } },
      update: { value: payload },
      create: { sessionId, keyId, value: payload },
    });
  };

  const remove = async (keyId) => {
    await prisma.whatsAppKey.deleteMany({ where: { sessionId, keyId } });
  };

  const creds = (await read("creds")) || initAuthCreds();

  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        const data = {};
        await Promise.all(
          ids.map(async (id) => {
            let value = await read(`${type}-${id}`);
            if (type === "app-state-sync-key" && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }),
        );
        return data;
      },
      set: async (data) => {
        for (const category of Object.keys(data)) {
          for (const id of Object.keys(data[category] || {})) {
            const value = data[category][id];
            const keyId = `${category}-${id}`;
            if (value) await write(keyId, value);
            else await remove(keyId);
          }
        }
      },
    },
  };

  return { state, saveCreds: () => write("creds", creds), wipe: () => prisma.whatsAppKey.deleteMany({ where: { sessionId } }) };
}

/* --------------------------------- worker --------------------------------- */

export function createWorker({ prisma, makeSocket, logger = console, workerId = WORKER_ID }) {
  /** id -> { sock, saveCreds, wipe } */
  const sockets = new Map();
  const attempts = new Map();
  const retryTimers = new Map();

  const log = async (sessionId, level, message) => {
    try {
      await prisma.whatsAppLog.create({ data: { sessionId, level, message: String(message).slice(0, 800) } });
    } catch (err) {
      logger.error("[wa] log write failed", err?.message);
    }
  };

  const setStatus = async (id, data) => {
    try {
      await prisma.whatsAppSession.update({ where: { id }, data });
    } catch (err) {
      logger.error("[wa] status write failed", err?.message);
    }
  };

  const claim = async (id, from, to) => {
    const res = await prisma.whatsAppSession.updateMany({
      where: { id, status: { in: from } },
      data: { status: to, workerId },
    });
    return res.count === 1;
  };

  async function requestCode(row, sock) {
    const phone = (row.phone || "").replace(/\D/g, "");
    if (!phone) {
      await setStatus(row.id, { status: "ERROR", statusDetail: "No phone number on this session." });
      await log(row.id, "ERROR", "Cannot request a pairing code without a phone number");
      return;
    }
    try {
      const code = await sock.requestPairingCode(phone);
      const expiresAt = new Date(Date.now() + CODE_TTL_MS);
      await setStatus(row.id, {
        status: "PAIRING_CODE",
        lastSeenAt: new Date(),
        pairingCode: code,
        pairingExpiresAt: expiresAt,
        statusDetail: "Enter the code on your phone: WhatsApp → Linked devices → Link with phone number",
        workerId,
      });
      await log(row.id, "INFO", `Pairing code issued for +${phone} (valid 60s)`);
    } catch (err) {
      await setStatus(row.id, {
        status: "ERROR",
        statusDetail: `WhatsApp rejected the pairing request: ${err?.message || "unknown error"}`,
      });
      await log(row.id, "ERROR", `requestPairingCode failed: ${err?.message || err}`);
    }
  }

  async function start(row) {
    if (sockets.has(row.id)) return;

    const { state, saveCreds, wipe } = await useDbAuthState(prisma, row.id);
    // Persist the identity immediately so a crash mid-pairing can resume.
    await saveCreds().catch((err) => logger.error("[wa] initial creds save failed", err?.message));
    const sock = makeSocket(state);
    sockets.set(row.id, { sock, saveCreds, wipe, codeRequested: false });

    await prisma.whatsAppSession
      .update({ where: { id: row.id }, data: { lastSeenAt: new Date() } })
      .catch(() => undefined);
    await log(
      row.id,
      "INFO",
      state.creds.registered ? "Opening socket with stored credentials" : "Opening socket for a new registration",
    );

    sock.ev.on("creds.update", async () => {
      try {
        await saveCreds();
        await prisma.whatsAppSession.update({ where: { id: row.id }, data: { lastSeenAt: new Date() } });
      } catch (err) {
        logger.error("[wa] creds save failed", err?.message);
      }
    });

    sock.ev.on("connection.update", async (update) => {
      try {
        // Baileys only accepts requestPairingCode after the websocket handshake,
        // which is exactly when it would otherwise emit a QR payload.
        if (update.qr && !state.creds.registered) {
          const entry = sockets.get(row.id);
          if (entry && !entry.codeRequested) {
            entry.codeRequested = true;
            await requestCode(row, sock);
          }
        }

        if (update.connection === "open") {
          const jid = sock.user?.id || "";
          await setStatus(row.id, {
            status: "CONNECTED",
            statusDetail: "",
            connectedAt: new Date(),
            lastSeenAt: new Date(),
            meJid: jid,
            meNumber: jid.split(":")[0].split("@")[0],
            platform: sock.user?.platform || "unknown",
            pairingCode: "",
            pairingExpiresAt: null,
            workerId,
          });
          attempts.set(row.id, 0);
          await log(row.id, "INFO", `Connected as +${jid.split(":")[0].split("@")[0] || "unknown"}`);
        }

        if (update.connection === "close") {
          const statusCode = update.lastDisconnect?.error?.output?.statusCode;
          const reason = update.lastDisconnect?.error?.message || "socket closed";
          sockets.delete(row.id);

          const current = await prisma.whatsAppSession.findUnique({
            where: { id: row.id },
            select: { status: true, disconnectCount: true },
          });
          if (!current || current.status === "LOGGED_OUT") return;

          if (statusCode === DisconnectReason.loggedOut) {
            await wipe();
            await setStatus(row.id, {
              status: "LOGGED_OUT",
              statusDetail: "WhatsApp unlinked this device (logged out on the phone).",
              connectedAt: null,
              pairingCode: "",
              pairingExpiresAt: null,
            });
            await log(row.id, "WARN", "Session logged out by WhatsApp — credentials wiped");
            return;
          }

          const count = (attempts.get(row.id) || 0) + 1;
          attempts.set(row.id, count);
          await setStatus(row.id, {
            status: "DISCONNECTED",
            statusDetail: `${reason}${statusCode ? ` (code ${statusCode})` : ""}`,
            connectedAt: null,
            disconnectCount: { increment: 1 },
          });
          await log(row.id, "WARN", `Disconnected: ${reason}${statusCode ? ` [${statusCode}]` : ""}`);

          if (count <= MAX_RETRIES) {
            const delay = Math.min(60_000, 2_000 * 2 ** (count - 1));
            await log(row.id, "INFO", `Reconnecting in ${Math.round(delay / 1000)}s (attempt ${count}/${MAX_RETRIES})`);
            const timer = setTimeout(() => {
              retryTimers.delete(row.id);
              void reconnect(row.id);
            }, delay);
            retryTimers.set(row.id, timer);
          } else {
            await log(row.id, "ERROR", `Giving up after ${MAX_RETRIES} attempts — press Restart to retry`);
          }
        }
      } catch (err) {
        logger.error("[wa] connection.update handler failed", err?.message);
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const m of messages.slice(0, 3)) {
        await log(row.id, "INFO", `Inbound message from ${m.key?.remoteJid || "unknown"}`);
      }
    });

  }

  async function reconnect(id) {
    const row = await prisma.whatsAppSession.findUnique({
      where: { id },
      select: { id: true, phone: true, status: true, _count: { select: { keys: true } } },
    });
    if (!row || row.status === "LOGGED_OUT" || sockets.has(id)) return;

    if (row._count.keys === 0) {
      await log(id, "WARN", "No stored credentials — pair again to reconnect");
      return;
    }
    if (!(await claim(id, ["DISCONNECTED", "CONNECTING", "RECONNECT_REQUESTED", "CONNECTED"], "CONNECTING"))) return;
    await log(id, "INFO", "Reconnecting with stored credentials");
    await start(row);
  }

  async function closeSocket(id, logout = false) {
    const entry = sockets.get(id);
    if (!entry) return;
    sockets.delete(id);
    try {
      if (logout) await entry.sock.logout?.();
      else entry.sock.end?.(undefined);
    } catch {
      /* socket already gone */
    }
    const timer = retryTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      retryTimers.delete(id);
    }
  }

  async function reconcile() {
    const rows = await prisma.whatsAppSession.findMany({
      select: {
        id: true,
        phone: true,
        status: true,
        lastSeenAt: true,
        updatedAt: true,
        _count: { select: { keys: true } },
      },
    });

    const seen = new Set(rows.map((r) => r.id));
    for (const id of [...sockets.keys()]) {
      if (!seen.has(id)) {
        await log(id, "INFO", "Session removed — closing socket");
        await closeSocket(id, true);
      }
    }

    for (const row of rows) {
      const age = Date.now() - row.updatedAt.getTime();
      const live = sockets.has(row.id);

      if (row.status === "LOGGED_OUT") {
        const entry = sockets.get(row.id);
        if (entry) {
          entry.sock.end?.(undefined);
          sockets.delete(row.id);
          await entry.wipe();
        } else {
          await prisma.whatsAppKey.deleteMany({ where: { sessionId: row.id } });
        }
        continue;
      }

      if (row.status === "PAIRING_REQUESTED" && !live) {
        if (await claim(row.id, ["PAIRING_REQUESTED"], "CONNECTING")) {
          await log(row.id, "INFO", "Pairing requested by the dashboard");
          await start(row);
        }
        continue;
      }

      if (row.status === "RECONNECT_REQUESTED" && !live) {
        if (await claim(row.id, ["RECONNECT_REQUESTED"], "CONNECTING")) {
          await log(row.id, "INFO", "Restart requested — reusing stored credentials");
          await start(row);
        }
        continue;
      }

      // Worker restart: CONNECTED rows have no socket in this process.
      if (row.status === "CONNECTED" && !live) {
        const stale = !row.lastSeenAt || Date.now() - row.lastSeenAt.getTime() > 45_000;
        if (stale) {
          if (await claim(row.id, ["CONNECTED"], "CONNECTING")) await start(row);
        }
        continue;
      }

      // Never leave a half-open state behind after a crash.
      if (["CONNECTING", "PAIRING_CODE", "PAIRING_REQUESTED"].includes(row.status) && !live && age > STALE_MS) {
        await setStatus(row.id, {
          status: row._count.keys > 0 ? "DISCONNECTED" : "PAIRING_REQUESTED",
          statusDetail: "Recovered from an interrupted attempt.",
        });
        continue;
      }

      // Auto-heal a dropped connection that has credentials.
      if (row.status === "DISCONNECTED" && !live && row._count.keys > 0) {
        const count = attempts.get(row.id) || 0;
        if (count <= MAX_RETRIES && !retryTimers.has(row.id) && age > 5_000) {
          void reconnect(row.id);
        }
      }
    }
  }

  async function heartbeat() {
    if (!sockets.size) return;
    const ids = [...sockets.keys()];
    await prisma.whatsAppSession.updateMany({
      where: { id: { in: ids }, status: "CONNECTED" },
      data: { lastSeenAt: new Date() },
    });
  }

  async function maintenance() {
    const cutoff = new Date(Date.now() - 7 * 86_400_000);
    await prisma.whatsAppLog.deleteMany({ where: { createdAt: { lt: cutoff } } }).catch(() => undefined);
  }

  async function shutdown() {
    for (const id of [...sockets.keys()]) await closeSocket(id, false);
    for (const timer of retryTimers.values()) clearTimeout(timer);
    retryTimers.clear();
  }

  return { reconcile, heartbeat, maintenance, shutdown, sockets, attempts };
}

/* ---------------------------------- main ---------------------------------- */

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const prisma = new PrismaClient();
  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {
    console.warn("[wa] could not fetch the latest WhatsApp version, using the bundled default");
  }

  const silent = () => {
    const l = {
      level: "silent",
      child: () => l,
      trace() {},
      debug() {},
      info() {},
      warn() {},
      error() {},
      fatal() {},
    };
    return l;
  };

  const worker = createWorker({
    prisma,
    makeSocket: (state) =>
      makeWASocket({
        auth: state,
        version,
        printQRInTerminal: false,
        browser: Browsers.ubuntu("Chrome"),
        logger: silent(),
        syncFullHistory: false,
        markOnlineOnConnect: false,
        connectTimeoutMs: 30_000,
        defaultQueryTimeoutMs: 30_000,
      }),
  });

  console.log(`[wa] worker ${WORKER_ID} starting`);
  await worker.reconcile();
  setInterval(() => {
    worker.reconcile().catch((err) => console.error("[wa] reconcile", err?.message));
  }, TICK_MS);
  setInterval(() => {
    worker.heartbeat().catch((err) => console.error("[wa] heartbeat", err?.message));
  }, HEARTBEAT_MS);
  setInterval(() => {
    worker.maintenance().catch(() => undefined);
  }, MAINTENANCE_MS);

  const stop = async (signal) => {
    console.log(`[wa] ${signal} received, closing sockets`);
    await worker.shutdown();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
}

if (process.argv[1] && process.argv[1].endsWith("worker/index.mjs")) {
  main().catch((err) => {
    console.error("[wa] fatal", err);
    process.exit(1);
  });
}
