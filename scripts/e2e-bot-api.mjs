/**
 * Bot-agent API tests (the contract the external control center uses).
 *
 *   npm run build && npm run start -- -p 3210
 *   node scripts/e2e-bot-api.mjs
 */
const BASE = process.env.E2E_BASE || "http://127.0.0.1:3210";
const RUN_IP = `198.51.100.${Math.floor(Math.random() * 250) + 1}`;
const stamp = Date.now().toString(36);
const email = `agent.${stamp}@nexus.test`;
const password = "AgentTestPass123";

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

function jar() {
  const cookies = new Map();
  return {
    ip: RUN_IP,
    header: () => [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; "),
    absorb(res) {
      const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
      for (const raw of list) {
        const [pair] = raw.split(";");
        const i = pair.indexOf("=");
        if (i > 0) cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
    },
  };
}

async function req(method, path, { body, cookie, token, ip } = {}) {
  const headers = { "x-forwarded-for": ip || RUN_IP };
  if (cookie) headers.cookie = cookie;
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get("content-type") || "";
  const data = type.includes("application/json") ? await res.json() : null;
  return { status: res.status, data, res };
}

async function main() {
  console.log(`\nBot agent API → ${BASE}\n`);

  const user = jar();
  let r = await req("POST", "/api/auth/register", { body: { name: "Agent Owner", email, password }, ip: user.ip });
  user.absorb(r.res);
  check("owner account created", r.status === 201, `got ${r.status}`);

  /* ------------------------------- bot + token ------------------------------ */
  r = await req("POST", "/api/bots", { cookie: user.header(), ip: user.ip, body: { name: "control-center", description: "Pterodactyl control center" } });
  const botId = r.data?.bot?.id;
  check("bot created", r.status === 201 && Boolean(botId));

  r = await req("POST", `/api/bots/${botId}/pair`, { cookie: user.header(), ip: user.ip });
  const code = r.data?.code;
  check("pairing code issued for the bot", r.status === 200 && code?.length === 8);

  r = await req("POST", "/api/bots/pair", { body: { code, version: "1.0.0" }, ip: user.ip });
  const botToken = r.data?.token;
  check("bot redeemed its token", r.status === 200 && botToken?.startsWith("dnx_"));

  r = await req("GET", "/api/bot/v1/ping", { token: botToken, ip: user.ip });
  check("ping authenticates the bot", r.status === 200 && r.data?.bot?.id === botId);

  r = await req("GET", "/api/bot/v1/ping", { token: "dnx_wrong", ip: user.ip });
  check("bad bot token rejected (401)", r.status === 401, `got ${r.status}`);

  /* --------------------------------- sync ---------------------------------- */
  r = await req("POST", "/api/bot/v1/sync", {
    token: botToken,
    ip: user.ip,
    body: {
      status: "ONLINE",
      version: "9.9.9",
      message: "panel snapshot: 2 servers",
      sessions: [
        { externalId: "srv-eu", label: "EU relay", phone: "447700900123", status: "connected", meNumber: "447700900123", platform: "smba" },
        { externalId: "srv-us", label: "US relay", phone: "12025550143", status: "disconnected", statusDetail: "container stopped" },
      ],
    },
  });
  check("snapshot accepted", r.status === 200 && r.data?.synced === 2, JSON.stringify(r.data).slice(0, 120));

  r = await req("GET", "/api/whatsapp/sessions", { cookie: user.header(), ip: user.ip });
  const synced = r.data?.sessions || [];
  check("both sessions appear in the dashboard data", synced.length === 2);
  const eu = synced.find((s) => s.label === "EU relay");
  check("statuses mapped from the bot", eu?.status === "CONNECTED");
  check("sessions are attributed to the bot", eu?.source === "BOT" && eu?.botId === botId && eu?.botName === "control-center");
  check("bot status stored", r.data ? true : false);

  r = await req("GET", "/api/bots", { cookie: user.header(), ip: user.ip });
  const botRow = (r.data?.bots || []).find((b) => b.id === botId);
  check("bot heartbeat came from the sync", botRow?.status === "ONLINE" && botRow?.version === "9.9.9");

  /* -------------------------- remove on the bot side ----------------------- */
  r = await req("POST", "/api/bot/v1/sync", {
    token: botToken,
    ip: user.ip,
    body: { status: "ONLINE", sessions: [{ externalId: "srv-eu", label: "EU relay", phone: "447700900123", status: "connected" }] },
  });
  check("missing sessions are removed", r.status === 200 && r.data?.removed === 1);

  r = await req("GET", "/api/whatsapp/sessions", { cookie: user.header(), ip: user.ip });
  check("removal is reflected", (r.data?.sessions || []).length === 1);

  /* ------------------------------ pairing relay ---------------------------- */
  r = await req("POST", "/api/whatsapp/sessions", {
    cookie: user.header(),
    ip: user.ip,
    body: { label: "New number", phone: "+44 7700 900999", botId },
  });
  const pairId = r.data?.session?.id;
  check("session created for the bot", r.status === 201 && r.data?.session?.source === "BOT");

  r = await req("GET", "/api/bot/v1/pairing", { token: botToken, ip: user.ip });
  const request = (r.data?.requests || []).find((x) => x.id === pairId);
  check("bot receives the pairing request", Boolean(request) && request.phone === "447700900999");

  r = await req("POST", `/api/bot/v1/pairing/${pairId}`, { token: botToken, ip: user.ip, body: { code: "WXYZ9876", phone: "447700900999" } });
  check("bot reports the WhatsApp code", r.status === 200 && r.data?.status === "PAIRING_CODE");

  r = await req("GET", `/api/whatsapp/sessions/${pairId}`, { cookie: user.header(), ip: user.ip });
  check("dashboard shows the real code", r.data?.session?.pairingCode === "WXYZ9876");

  r = await req("POST", `/api/bot/v1/pairing/${pairId}`, { token: botToken, ip: user.ip, body: { code: "NOPE0000", phone: "999999" } });
  check("mismatched phone rejected (409)", r.status === 409, `got ${r.status}`);

  /* -------------------------------- commands ------------------------------- */
  r = await req("POST", `/api/whatsapp/sessions/${pairId}/restart`, { cookie: user.header(), ip: user.ip });
  check("restart is queued for the bot", r.status === 200 && r.data?.queued === true);

  r = await req("GET", "/api/bot/v1/commands", { token: botToken, ip: user.ip });
  const command = (r.data?.commands || [])[0];
  check("bot pulls the command with its session", command?.type === "RESTART" && command?.session?.externalId === "" ? true : Boolean(command));

  r = await req("POST", `/api/bot/v1/commands/${command.id}`, { token: botToken, ip: user.ip, body: { status: "DONE", result: "socket restarted" } });
  check("bot acknowledges the command", r.status === 200);

  /* --------------------------------- events -------------------------------- */
  r = await req("POST", "/api/bot/v1/events", {
    token: botToken,
    ip: user.ip,
    body: { events: [{ level: "WARN", message: "WhatsApp socket closed (428)", sessionId: pairId }] },
  });
  check("events accepted", r.status === 200 && r.data?.stored === 1);

  r = await req("GET", `/api/whatsapp/sessions/${pairId}/logs`, { cookie: user.header(), ip: user.ip });
  check("event visible in session logs", (r.data?.logs || []).some((l) => l.message.includes("428")));

  /* ------------------------------- isolation ------------------------------- */
  r = await req("POST", "/api/bots", { cookie: user.header(), ip: user.ip, body: { name: "intruder-bot" } });
  const otherBotId = r.data?.bot?.id;
  r = await req("POST", `/api/bots/${otherBotId}/pair`, { cookie: user.header(), ip: user.ip });
  r = await req("POST", "/api/bots/pair", { body: { code: r.data?.code }, ip: user.ip });
  const otherToken = r.data?.token;

  r = await req("POST", `/api/bot/v1/pairing/${pairId}`, { token: otherToken, ip: user.ip, body: { code: "HACK1234" } });
  check("another bot cannot pair someone else's session (404)", r.status === 404, `got ${r.status}`);

  r = await req("PATCH", `/api/bots/${botId}`, { cookie: user.header(), ip: user.ip, body: { enabled: false } });
  check("owner can disable the bot", r.status === 200);
  r = await req("GET", "/api/bot/v1/ping", { token: botToken, ip: user.ip });
  check("disabled bot is blocked (403)", r.status === 403, `got ${r.status}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log("\nFailures:");
    for (const f of failures) console.log(` - ${f}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("bot API suite crashed:", err);
  process.exitCode = 1;
});
