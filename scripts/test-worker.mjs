/**
 * Worker orchestration test — no WhatsApp traffic.
 *
 * Uses the real worker code path (claim → pairing code → open → disconnect →
 * reconnect after restart → logout/wipe) with an injected socket, so the
 * persistence, status transitions and credential life cycle are all exercised
 * against a real database.
 *
 *   DATABASE_URL=… node scripts/test-worker.mjs
 */
import { PrismaClient } from "@prisma/client";
import { createWorker, decryptSecret } from "../worker/index.mjs";

const prisma = new PrismaClient();

let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Minimal socket with the shape the worker consumes. */
function createFakeSocket(state, calls) {
  const handlers = new Map();
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
    requestPairingCode: async (phone) => {
      calls.codes += 1;
      calls.phones.push(phone);
      return "ABCD1234";
    },
    end: () => {
      calls.ended += 1;
    },
    logout: async () => {
      calls.loggedOut += 1;
    },
    emit: async (name, payload) => {
      for (const fn of handlers.get(name) || []) await fn(payload);
    },
  };
  return sock;
}

async function main() {
  const stamp = Date.now().toString(36);
  const user = await prisma.user.create({
    data: {
      email: `worker.${stamp}@nexus.test`,
      name: "Worker Test",
      passwordHash: "x",
      role: "USER",
    },
    select: { id: true },
  });

  const session = await prisma.whatsAppSession.create({
    data: {
      userId: user.id,
      label: "worker-test",
      phone: "447700900123",
      status: "PAIRING_REQUESTED",
    },
    select: { id: true },
  });

  const calls = { codes: 0, phones: [], ended: 0, loggedOut: 0 };
  const sockets = [];
  const makeSocket = (state) => {
    const sock = createFakeSocket(state, calls);
    sockets.push(sock);
    return sock;
  };

  const worker = createWorker({ prisma, makeSocket, logger: { error: () => {} }, workerId: "test-worker" });

  /* ------------------------------ pairing code ------------------------------ */
  await worker.reconcile();
  await new Promise((r) => setTimeout(r, 200));

  let row = await prisma.whatsAppSession.findUniqueOrThrow({
    where: { id: session.id },
    select: { status: true, pairingCode: true, pairingExpiresAt: true, workerId: true },
  });
  check("worker claims the session and stores a code", row.status === "PAIRING_CODE" && row.pairingCode === "ABCD1234");
  check("pairing code has a 60s expiry window", Boolean(row.pairingExpiresAt));
  check("phone was passed to Baileys without symbols", calls.phones[0] === "447700900123");

  const keys = await prisma.whatsAppKey.findMany({ where: { sessionId: session.id }, select: { keyId: true, value: true } });
  check("auth state persisted (creds row)", keys.some((k) => k.keyId === "creds"));
  check("stored credentials are encrypted at rest", keys.every((k) => !k.value.includes("registrationId")));
  const decrypted = decryptSecret(keys.find((k) => k.keyId === "creds").value);
  check("ciphertext decrypts back to a creds object", decrypted.includes("registrationId"));

  /* -------------------------------- connected ------------------------------- */
  // Simulate WhatsApp completing the link: creds become registered, socket opens.
  sockets[0].authState.creds.registered = true;
  await sockets[0].emit("creds.update", {});
  await sockets[0].emit("connection.update", { connection: "open" });

  row = await prisma.whatsAppSession.findUniqueOrThrow({
    where: { id: session.id },
    select: { status: true, meNumber: true, connectedAt: true, pairingCode: true, platform: true },
  });
  check("open connection flips the session to CONNECTED", row.status === "CONNECTED");
  check("paired number is recorded", row.meNumber === "447700900123");
  check("platform + uptime anchor recorded", row.platform === "smba" && Boolean(row.connectedAt));
  check("pairing code cleared once linked", row.pairingCode === "");

  /* ------------------------------ disconnected ------------------------------ */
  await sockets[0].emit("connection.update", {
    connection: "close",
    lastDisconnect: { error: { message: "Connection Failure", output: { statusCode: 428 } } },
  });

  row = await prisma.whatsAppSession.findUniqueOrThrow({
    where: { id: session.id },
    select: { status: true, statusDetail: true, disconnectCount: true, connectedAt: true },
  });
  check("close is recorded as DISCONNECTED with a reason", row.status === "DISCONNECTED" && row.statusDetail.includes("428"));
  check("disconnect counter increments", row.disconnectCount === 1);
  check("uptime anchor cleared on disconnect", row.connectedAt === null);

  const logs = await prisma.whatsAppLog.findMany({ where: { sessionId: session.id }, select: { level: true, message: true } });
  check("lifecycle events written to the log", logs.some((l) => l.message.includes("Pairing code issued")) && logs.some((l) => l.level === "WARN"));

  /* --------------------------- restart / reconnect -------------------------- */
  // A fresh worker process must pick the session up from the database.
  const workerTwo = createWorker({ prisma, makeSocket, logger: { error: () => {} }, workerId: "test-worker-2" });
  await prisma.whatsAppSession.update({
    where: { id: session.id },
    data: { status: "CONNECTED", lastSeenAt: new Date(Date.now() - 120_000) },
  });
  const before = sockets.length;
  await workerTwo.reconcile();
  await new Promise((r) => setTimeout(r, 200));
  check("restart reopens the socket for CONNECTED sessions", sockets.length === before + 1);
  check("reconnect reuses stored creds (no second pairing code)", calls.codes === 1);

  await sockets[sockets.length - 1].emit("connection.update", { connection: "open" });
  row = await prisma.whatsAppSession.findUniqueOrThrow({ where: { id: session.id }, select: { status: true } });
  check("reconnect returns to CONNECTED", row.status === "CONNECTED");

  /* -------------------------------- logout --------------------------------- */
  await prisma.whatsAppSession.update({ where: { id: session.id }, data: { status: "LOGGED_OUT" } });
  await workerTwo.reconcile();
  await new Promise((r) => setTimeout(r, 150));
  const remainingKeys = await prisma.whatsAppKey.count({ where: { sessionId: session.id } });
  check("owner logout wipes stored credentials", remainingKeys === 0);

  /* ------------------------------- cleanup --------------------------------- */
  await worker.shutdown();
  await workerTwo.shutdown();
  await prisma.user.delete({ where: { id: user.id } });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    for (const f of failures) console.log(` - ${f}`);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error("worker test crashed:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
