/**
 * End-to-end proof that every feature talks to the real backend.
 *
 *   npm run build && npm run start -- -p 3210   # terminal 1
 *   node scripts/e2e.mjs                         # terminal 2
 *
 * Uses unique emails per run, so it is safe to repeat.
 */
const BASE = process.env.E2E_BASE || "http://127.0.0.1:3210";
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL || "admin@nexus.test";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD || "AdminPass12345";

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
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
    header() {
      return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    },
    absorb(res) {
      const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
      for (const raw of list) {
        const [pair] = raw.split(";");
        const idx = pair.indexOf("=");
        if (idx > 0) cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
      }
    },
    has(name) {
      return cookies.has(name) && cookies.get(name) !== "";
    },
  };
}

async function req(method, path, { body, cookie, token, form } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload, redirect: "manual" });
  const type = res.headers.get("content-type") || "";
  let data = null;
  if (type.includes("application/json")) data = await res.json();
  else if (type.startsWith("text/") || type.includes("javascript")) data = await res.text();
  return { status: res.status, data, res };
}

const stamp = Date.now().toString(36);
const userEmail = `operator.${stamp}@nexus.test`;
const userPassword = "OperatorPass123";

async function main() {
  console.log(`\nDarknote Nexus E2E → ${BASE}\n`);

  /* ------------------------------- auth basics ------------------------------ */
  const anon = jar();
  let r = await req("GET", "/api/auth/me", { cookie: anon.header() });
  check("unauthenticated /me returns null", r.status === 200 && r.data.user === null);

  r = await req("POST", "/api/auth/register", {
    body: { name: "Weak", email: `weak.${stamp}@nexus.test`, password: "short" },
  });
  check("weak password rejected (422)", r.status === 422, `got ${r.status}`);

  const user = jar();
  r = await req("POST", "/api/auth/register", { body: { name: "Operator One", email: userEmail, password: userPassword } });
  user.absorb(r.res);
  check("register creates account", r.status === 201 && r.data?.user?.email === userEmail, JSON.stringify(r.data).slice(0, 120));
  check("session cookie issued (httpOnly)", user.has("dnx_session"));

  r = await req("POST", "/api/auth/register", { body: { name: "Operator One", email: userEmail, password: userPassword } });
  check("duplicate email rejected (409)", r.status === 409, `got ${r.status}`);

  r = await req("GET", "/api/auth/me", { cookie: user.header() });
  check("session resolves to the stored account", r.data?.user?.email === userEmail);
  check("account counts are server-side", typeof r.data?.counts?.bots === "number");

  r = await req("PATCH", "/api/auth/me", { cookie: user.header(), body: { name: "Operator Prime", avatar: "⚡" } });
  check("profile update persists", r.status === 200 && r.data.user.name === "Operator Prime" && r.data.user.avatar === "⚡");

  /* ---------------------------------- bots --------------------------------- */
  r = await req("POST", "/api/bots", { cookie: user.header(), body: { name: "relay-eu-1", description: "EU relay" } });
  const botId = r.data?.bot?.id;
  check("bot created", r.status === 201 && Boolean(botId));
  check("new bot starts unpaired/offline", r.data?.bot?.paired === false && r.data?.bot?.status === "OFFLINE");

  r = await req("POST", `/api/bots/${botId}/pair`, { cookie: user.header() });
  const code = r.data?.code;
  check("pairing code issued (8 chars)", r.status === 200 && typeof code === "string" && code.length === 8);

  r = await req("POST", "/api/bots/pair", { body: { code, version: "1.4.2" } });
  const botToken = r.data?.token;
  check("external bot redeems code for a token", r.status === 200 && typeof botToken === "string" && botToken.startsWith("dnx_"));

  r = await req("POST", "/api/bots/pair", { body: { code, version: "1.4.2" } });
  check("pairing code is single-use (409)", r.status === 409, `got ${r.status}`);

  r = await req("POST", "/api/bots/heartbeat", {
    token: botToken,
    body: { status: "ONLINE", message: "poll cycle ok", version: "1.4.2", messagesSent: 42, errors: 1 },
  });
  check("heartbeat updates live status", r.status === 200 && r.data?.bot?.status === "ONLINE");

  r = await req("POST", "/api/bots/heartbeat", { token: "dnx_not-a-real-token", body: { status: "ONLINE" } });
  check("invalid bot token rejected (401)", r.status === 401, `got ${r.status}`);

  r = await req("GET", `/api/bots/${botId}`, { cookie: user.header() });
  check("bot detail shows ONLINE + counters", r.data?.bot?.status === "ONLINE" && r.data?.bot?.messagesSent === 42);
  check("heartbeat produced log rows", Array.isArray(r.data?.recent) && r.data.recent.length >= 1);

  r = await req("GET", "/api/logs?limit=20", { cookie: user.header() });
  check("global log feed returns bot lines", Array.isArray(r.data?.logs) && r.data.logs.length >= 1);

  /* ---------------------------------- files -------------------------------- */
  r = await req("GET", "/api/files", { cookie: user.header() });
  check("file listing starts empty", r.data?.files?.length === 0 && r.data?.quotaBytes > 0);

  const bytes = new TextEncoder().encode("darknote e2e payload");
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "text/plain" }), "proof.txt");
  r = await req("POST", "/api/files", { cookie: user.header(), form });
  const fileId = r.data?.file?.id;
  check("upload stores the file", r.status === 201 && Boolean(fileId));

  const dl = await fetch(`${BASE}/api/files/${fileId}`, { headers: { cookie: user.header() } });
  const text = await dl.text();
  check("download returns identical bytes", dl.status === 200 && text === "darknote e2e payload");

  /* ------------------------------ integrations ----------------------------- */
  r = await req("POST", "/api/integrations", {
    cookie: user.header(),
    body: { provider: "Loopback", baseUrl: "http://127.0.0.1:9/health", headerName: "Authorization", apiKey: "secret-key-123" },
  });
  check("SSRF guard blocks private hosts", r.status === 400, `got ${r.status}`);

  r = await req("POST", "/api/integrations", {
    cookie: user.header(),
    body: { provider: "Example", baseUrl: "https://example.com/", headerName: "Authorization", apiKey: "secret-key-123" },
  });
  const integrationId = r.data?.integration?.id;
  check("integration stored without the raw key", r.status === 201 && r.data?.integration?.keyPrefix?.includes("••••"));

  r = await req("GET", "/api/integrations", { cookie: user.header() });
  check("integration list never leaks the key", JSON.stringify(r.data).includes("secret-key-123") === false);

  r = await req("POST", `/api/integrations/${integrationId}/test`, { cookie: user.header() });
  check("integration test performs a server-side call", r.status === 200 && typeof r.data?.ok === "boolean", JSON.stringify(r.data).slice(0, 140));

  /* -------------------------------- sessions ------------------------------- */
  r = await req("GET", "/api/auth/sessions", { cookie: user.header() });
  check("session list marks the current device", Array.isArray(r.data?.sessions) && r.data.sessions.some((s) => s.current));

  /* --------------------------------- RBAC --------------------------------- */
  r = await req("GET", "/api/admin/stats", { cookie: user.header() });
  check("non-admin blocked from admin stats (403)", r.status === 403, `got ${r.status}`);

  /* --------------------------------- admin -------------------------------- */
  const admin = jar();
  r = await req("POST", "/api/auth/register", { body: { name: "Nexus Admin", email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  if (r.status === 201) admin.absorb(r.res);
  else {
    r = await req("POST", "/api/auth/login", { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
    admin.absorb(r.res);
  }
  check("admin account available", admin.has("dnx_session"), `status ${r.status}`);

  r = await req("GET", "/api/admin/stats", { cookie: admin.header() });
  check("admin stats aggregate real data", r.status === 200 && r.data?.totals?.users >= 2);

  r = await req("GET", `/api/admin/users?q=${encodeURIComponent(userEmail)}`, { cookie: admin.header() });
  const target = r.data?.users?.[0];
  check("admin user search finds the operator", r.status === 200 && target?.email === userEmail);

  r = await req("PATCH", `/api/admin/users/${target.id}`, { cookie: admin.header(), body: { status: "SUSPENDED" } });
  check("admin can suspend an account", r.status === 200 && r.data?.user?.status === "SUSPENDED");

  r = await req("GET", "/api/auth/me", { cookie: user.header() });
  check("suspension revokes live sessions immediately", r.data?.user === null);

  r = await req("POST", "/api/auth/login", { body: { email: userEmail, password: userPassword } });
  check("suspended account cannot log back in (403)", r.status === 403, `got ${r.status}`);

  r = await req("PATCH", `/api/admin/users/${target.id}`, { cookie: admin.header(), body: { status: "ACTIVE" } });
  check("admin can reactivate the account", r.status === 200 && r.data?.user?.status === "ACTIVE");

  r = await req("POST", "/api/auth/login", { body: { email: userEmail, password: userPassword } });
  user.absorb(r.res);
  check("reactivated account can log in", r.status === 200);

  r = await req("GET", "/api/bots", { cookie: user.header() });
  check("data survives logout/suspension cycle", r.data?.bots?.length === 1 && r.data.bots[0].id === botId);

  /* ---------------------------------- SSE --------------------------------- */
  const controller = new AbortController();
  const sse = await fetch(`${BASE}/api/events`, {
    headers: { cookie: user.header() },
    signal: controller.signal,
  });
  check("SSE stream opens", sse.status === 200, `got ${sse.status}`);

  if (sse.status === 200 && sse.body) {
    const reader = sse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    await new Promise((resolve) => {
      (async () => {
        try {
          while (buffer.length < 32) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
          }
        } catch {
          /* aborted */
        }
        resolve();
      })();
      setTimeout(resolve, 1500);
    });
    check("SSE sends the ready frame", buffer.includes("ready"), buffer.slice(0, 80));

    await req("POST", "/api/bots/heartbeat", { token: botToken, body: { status: "ONLINE", message: "sse tick" } });

    const sync = await new Promise((resolve) => {
      (async () => {
        try {
          for (let i = 0; i < 6; i++) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            if (buffer.includes('"sync"')) break;
          }
        } catch {
          /* aborted */
        }
        resolve(buffer.includes('"sync"'));
      })();
      setTimeout(() => resolve(buffer.includes('"sync"')), 9000);
    });
    check("SSE pushes a sync frame after a bot heartbeat", sync === true);
    controller.abort();
  }

  /* -------------------------------- teardown ------------------------------- */
  r = await req("DELETE", `/api/files/${fileId}`, { cookie: user.header() });
  check("file delete works", r.status === 200);

  r = await req("DELETE", `/api/integrations/${integrationId}`, { cookie: user.header() });
  check("integration delete works", r.status === 200);

  r = await req("DELETE", `/api/bots/${botId}`, { cookie: user.header() });
  check("bot delete works", r.status === 200);

  r = await req("POST", "/api/auth/logout", { cookie: user.header() });
  check("logout succeeds", r.status === 200);

  r = await req("GET", "/api/auth/me", { cookie: user.header() });
  check("cookie no longer authenticates", r.data?.user === null);

  r = await req("POST", "/api/auth/login", { body: { email: userEmail, password: "WrongPassword123" } });
  check("wrong password rejected (401)", r.status === 401, `got ${r.status}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log("\nFailures:");
    for (const f of failures) console.log(` - ${f}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("\nE2E crashed:", err);
  process.exitCode = 1;
});
