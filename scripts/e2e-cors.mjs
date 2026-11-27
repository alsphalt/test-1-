/**
 * Origin/CORS behaviour for the signup endpoint.
 *
 * Start the server with the same env the test expects:
 *   ALLOWED_ORIGINS="https://preview.example" APP_URL="http://127.0.0.1:3210" npm run start -- -p 3210
 *   node scripts/e2e-cors.mjs
 */
const BASE = process.env.E2E_BASE || "http://127.0.0.1:3210";
const ALLOWED = process.env.E2E_ALLOWED_ORIGIN || "https://preview.example";
const BLOCKED = "https://evil.example";
const ip = `198.51.100.${Math.floor(Math.random() * 250) + 1}`;

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

async function preflight(origin, method = "POST", headers = "content-type") {
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": method,
      "access-control-request-headers": headers,
      "x-forwarded-for": ip,
    },
  });
  return {
    status: res.status,
    allow: res.headers.get("access-control-allow-origin"),
    creds: res.headers.get("access-control-allow-credentials"),
    methods: res.headers.get("access-control-allow-methods"),
    headers: res.headers.get("access-control-allow-headers"),
  };
}

async function register(origin, email) {
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      "x-forwarded-for": ip,
    },
    body: JSON.stringify({ name: "CORS User", email, password: "CorsPass12345" }),
  });
  const cookies = res.headers.getSetCookie?.() || [];
  return {
    status: res.status,
    allow: res.headers.get("access-control-allow-origin"),
    creds: res.headers.get("access-control-allow-credentials"),
    data: await res.json().catch(() => null),
    cookies,
  };
}

const stamp = Date.now().toString(36);

console.log(`\nCORS / origin checks → ${BASE}\n`);

let r = await preflight(ALLOWED);
check("preflight from an allowed origin returns 204", r.status === 204, `got ${r.status}`);
check("preflight echoes the exact origin (no wildcard)", r.allow === ALLOWED, `got ${r.allow}`);
check("preflight allows credentials", r.creds === "true", `got ${r.creds}`);
check("preflight agrees the requested method", r.methods === "POST", `got ${r.methods}`);
check("preflight reflects the requested headers", (r.headers || "").includes("content-type"), `got ${r.headers}`);

r = await preflight(ALLOWED, "PATCH", "content-type, x-csrf-token");
check("preflight accepts an extra header instead of failing it", (r.headers || "").includes("x-csrf-token"), `got ${r.headers}`);

r = await preflight(BLOCKED);
check("preflight from an unknown origin grants nothing", !r.allow || r.allow !== BLOCKED, `got ${r.allow}`);
check("unknown origin gets no credentials grant", r.creds !== "true", `got ${r.creds}`);

r = await register(ALLOWED, `cors.allowed.${stamp}@nexus.test`);
check("signup from an allowed origin succeeds", r.status === 201, `got ${r.status} ${JSON.stringify(r.data).slice(0, 100)}`);
check("allowed origin gets CORS headers on the POST", r.allow === ALLOWED);
const sessionCookie = r.cookies.find((c) => c.startsWith("dnx_session=")) || "";
check("account was persisted", Boolean(sessionCookie));
check("session cookie is HttpOnly", /HttpOnly/i.test(sessionCookie), sessionCookie);
check("session cookie declares SameSite", /SameSite=(Lax|Strict|None)/i.test(sessionCookie), sessionCookie);
check("session cookie is scoped to /", /Path=\//i.test(sessionCookie), sessionCookie);

r = await register(BLOCKED, `cors.blocked.${stamp}@nexus.test`);
check("signup from an unknown origin is rejected (403)", r.status === 403, `got ${r.status}`);
check(
  "rejection is readable by a browser (origin echoed, no credentials)",
  r.allow === BLOCKED && r.creds !== "true",
  `allow=${r.allow} creds=${r.creds}`,
);
check("rejection explains the fix", r.data?.error?.code === "CROSS_ORIGIN" && /ALLOWED_ORIGINS/.test(r.data?.error?.message || ""));

r = await register("", `cors.same.${stamp}@nexus.test`);
check("same-origin (no Origin header) still works", r.status === 201, `got ${r.status}`);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log("\nFailures:");
  for (const f of failures) console.log(` - ${f}`);
  process.exitCode = 1;
}
