/**
 * Authentication smoke test against a running deployment.
 *
 *   node scripts/e2e-auth.mjs
 *   E2E_BASE=https://your-app.vercel.app node scripts/e2e-auth.mjs
 *
 * Uses a unique account per run and prints the raw status + error code for
 * every step, so a failing deployment shows the real backend message instead
 * of "Something went wrong".
 */
const BASE = (process.env.E2E_BASE || "http://127.0.0.1:3210").replace(/\/$/, "");
const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const EMAIL = process.env.E2E_AUTH_EMAIL || `auth.${stamp}@nexus.test`;
const PASSWORD = process.env.E2E_AUTH_PASSWORD || "AuthPass12345";

let passed = 0;
let failed = 0;

function check(name, cond, detail = "") {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const cookies = new Map();

async function call(method, path, body) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookies.size) headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });

  for (const raw of res.headers.getSetCookie?.() || []) {
    const [pair] = raw.split(";");
    const i = pair.indexOf("=");
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    if (value === "") cookies.delete(name);
    else cookies.set(name, value);
  }

  const type = res.headers.get("content-type") || "";
  const data = type.includes("application/json") ? await res.json().catch(() => null) : null;
  return { status: res.status, data };
}

function code(r) {
  return r.data?.error?.code || "";
}

console.log(`\nAuth checks → ${BASE}\n`);

let r = await call("GET", "/api/health");
check("health endpoint reachable", r.status === 200, `got ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`);
if (r.status === 200) {
  check("database reachable", r.data?.database?.reachable === true, JSON.stringify(r.data?.database));
  check("database schema present", r.data?.database?.schema === true, JSON.stringify(r.data?.database));
  check("AUTH_SECRET configured", r.data?.env?.AUTH_SECRET === "set", String(r.data?.env?.AUTH_SECRET));
}

r = await call("POST", "/api/auth/register", { name: "Auth Tester", email: EMAIL, password: PASSWORD });
check(
  "registration succeeds",
  r.status === 201 || (r.status === 409 && EMAIL.startsWith("auth.manual.")),
  `got ${r.status} ${JSON.stringify(r.data)}`,
);

r = await call("GET", "/api/auth/me");
check("session persists immediately after registration", Boolean(r.data?.user?.email === EMAIL), JSON.stringify(r.data).slice(0, 120));

r = await call("POST", "/api/auth/logout");
check("logout succeeds", r.status === 200, `got ${r.status}`);

r = await call("GET", "/api/auth/me");
check("session cleared after logout", r.data?.user === null);

r = await call("POST", "/api/auth/login", { email: EMAIL, password: PASSWORD });
check("login succeeds with the registered account", r.status === 200, `got ${r.status} ${JSON.stringify(r.data)}`);
check("login returns the user", r.data?.user?.email === EMAIL);
check("login sets an httpOnly session cookie", cookies.has("dnx_session"));

r = await call("GET", "/api/auth/me");
check("session persists after login", r.data?.user?.email === EMAIL, JSON.stringify(r.data).slice(0, 120));

r = await call("POST", "/api/auth/login", { email: EMAIL, password: "DefinitelyWrong123" });
check("wrong password returns 401 with a real message", r.status === 401 && code(r) === "INVALID_CREDENTIALS", `got ${r.status} ${code(r)}`);

r = await call("POST", "/api/auth/login", { email: `nobody.${stamp}@nexus.test`, password: PASSWORD });
check("unknown account returns 401, not 500", r.status === 401, `got ${r.status} ${code(r)}`);

r = await call("POST", "/api/auth/login", { email: "not-an-email", password: "x" });
check("invalid input returns 422, not 500", r.status === 422, `got ${r.status} ${code(r)}`);

r = await call("POST", "/api/auth/login", { email: EMAIL, password: PASSWORD });
check("re-login after logout works", r.status === 200, `got ${r.status} ${JSON.stringify(r.data)}`);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
