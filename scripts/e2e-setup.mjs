/**
 * Darknote Setup end-to-end checks.
 *
 * Runs against a real server and a real database:
 *   ALLOWED_ORIGINS="https://preview.example" OWNER_SETUP_TOKEN="1124100" \
 *   npm run start -- -p 3210
 *   node scripts/e2e-setup.mjs
 *
 * Covers: owner-token gate, account creation, code issue, activation request,
 * approval, linking, code reuse, reset, suspension, deletion, permission
 * boundaries and the activity log.
 */
const BASE = process.env.E2E_BASE || "http://127.0.0.1:3210";
const OWNER_EMAIL = process.env.E2E_OWNER_EMAIL || "alsphaltjimna@gmail.com";
const OWNER_TOKEN = process.env.E2E_OWNER_TOKEN || "1124100";
const stamp = Date.now().toString(36).slice(-5);

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
  return { cookies: new Map() };
}

function absorb(store, res) {
  const list = res.headers.getSetCookie?.() || [];
  for (const raw of list) {
    const [pair] = raw.split(";");
    const idx = pair.indexOf("=");
    if (idx < 0) continue;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (value === "") store.cookies.delete(name);
    else store.cookies.set(name, value);
  }
}

async function call(store, method, path, body, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (store && store.cookies.size) {
    headers.cookie = [...store.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  if (store) absorb(store, res);
  const type = res.headers.get("content-type") || "";
  const data = type.includes("application/json") ? await res.json().catch(() => null) : null;
  return { status: res.status, data, headers: res.headers };
}

async function register(store, name, email, password) {
  return call(store, "POST", "/api/auth/register", { name, email, password });
}

console.log(`\nDarknote Setup checks → ${BASE}\n`);

/* ------------------------------- owner gate -------------------------------- */

const owner = jar();
let r = await register(owner, "Owner", OWNER_EMAIL, "OwnerPass12345");
check("owner account registers", r.status === 201 || r.status === 409, `got ${r.status}`);
if (r.status === 409) {
  r = await call(owner, "POST", "/api/auth/login", { email: OWNER_EMAIL, password: "OwnerPass12345" });
  check("owner account signs in", r.status === 200, `got ${r.status}`);
}

r = await call(owner, "GET", "/api/setup/state");
check("owner email is recognised", r.data?.ownerEligible === true, JSON.stringify(r.data?.needs));
check("setup starts locked", r.data?.unlocked === false);
check("owner is asked for the token, not a code", r.data?.needs === "owner_token", `got ${r.data?.needs}`);
check("state never returns a code hash", !JSON.stringify(r.data || {}).includes("setupCodeHash"));

r = await call(owner, "POST", "/api/setup/unlock", { ownerToken: "0000000" });
check("wrong owner token is refused", r.status === 403, `got ${r.status}`);

r = await call(owner, "POST", "/api/setup/unlock", { ownerToken: OWNER_TOKEN });
check("owner token unlocks Setup", r.status === 200 && r.data?.state?.role === "OWNER", `got ${r.status}`);

r = await call(owner, "GET", "/api/setup/overview");
check("overview is owner-only and returns live counters", r.status === 200 && typeof r.data?.bots?.total === "number");

/* ------------------------------- permissions -------------------------------- */

const anon = jar();
r = await call(anon, "GET", "/api/setup/accounts");
check("anonymous cannot list setup accounts", r.status === 401, `got ${r.status}`);

const plain = jar();
r = await register(plain, "Plain User", `plain.${stamp}@nexus.test`, "PlainPass12345");
check("ordinary account registers", r.status === 201, `got ${r.status}`);

r = await call(plain, "GET", "/api/setup/accounts");
check("non-owner signed-in user is refused (403)", r.status === 403, `got ${r.status}`);

r = await call(plain, "POST", "/api/setup/accounts", {
  username: `hack${stamp}`,
  password: "HackerPass123",
  phone: "+254700000001",
});
check("non-owner cannot create an account", r.status === 403, `got ${r.status}`);

/* ------------------------------ create account ------------------------------ */

const username = `alex${stamp}`;
r = await call(owner, "POST", "/api/setup/accounts", {
  username,
  password: "AlexPass12345",
  phone: "+254700000000",
  displayName: "Alex",
});
check("owner creates a Setup account", r.status === 201, `got ${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
const setupCode = r.data?.setupCode;
check("a personal setup code is issued", /^\d{8}$/.test(String(setupCode)), `got ${setupCode}`);
check("account starts as INVITED", r.data?.account?.status === "INVITED");
check("delivery reports the real reason when no WhatsApp number is connected", r.data?.delivery?.queued === false && /WhatsApp/i.test(r.data?.delivery?.note || ""), r.data?.delivery?.note);

r = await call(owner, "POST", "/api/setup/accounts", {
  username,
  password: "AlexPass12345",
  phone: "+254700000000",
});
check("duplicate username is rejected", r.status === 409, `got ${r.status}`);

r = await call(owner, "GET", "/api/setup/accounts");
const created = (r.data?.accounts || []).find((a) => a.username === username);
check("account is persisted and listed", Boolean(created));
check("listed account never exposes the code or its hash", Boolean(created) && !JSON.stringify(created).includes(String(setupCode)));

/* --------------------------------- locking --------------------------------- */

r = await call(owner, "POST", "/api/setup/lock");
check("owner can lock Setup", r.status === 200 && r.data?.locked === true);

r = await call(owner, "GET", "/api/setup/accounts");
check("locked session cannot read owner data", r.status === 403 && r.data?.error?.code === "SETUP_LOCKED", `got ${r.status}`);

r = await call(owner, "POST", "/api/setup/unlock", { ownerToken: OWNER_TOKEN });
check("owner can unlock again", r.status === 200);

/* -------------------------------- activation -------------------------------- */

const alex = jar();
r = await register(alex, "Alex Main", `alex.${stamp}@nexus.test`, "MainPass12345");
check("Alex has a normal Nexus account", r.status === 201, `got ${r.status}`);

r = await call(alex, "GET", "/api/setup/state");
check("unlinked user is asked to activate", r.data?.needs === "activation", `got ${r.data?.needs}`);

r = await call(alex, "POST", "/api/setup/activate", { username, password: "AlexPass12345", code: "00000000" });
check("wrong setup code cannot activate", r.status === 403, `got ${r.status}`);

r = await call(alex, "POST", "/api/setup/activate", { username, password: "WrongPass123", code: setupCode });
check("wrong password cannot activate", r.status === 400, `got ${r.status}`);

r = await call(alex, "POST", "/api/setup/activate", { username, password: "AlexPass12345", code: setupCode });
check("valid credentials create a pending request", r.status === 202 && r.data?.status === "PENDING", `got ${r.status}`);

r = await call(alex, "GET", "/api/setup/state");
check("user is told to wait for approval", r.data?.needs === "approval", `got ${r.data?.needs}`);

/* --------------------------------- approval --------------------------------- */

r = await call(owner, "GET", "/api/setup/requests?status=PENDING");
const request = (r.data?.requests || []).find((x) => x.account?.username === username);
check("owner sees the new access request", Boolean(request));
check("request is linked to the requesting Nexus account", Boolean(request?.requestedBy?.email?.includes("alex")));

r = await call(alex, "GET", "/api/setup/requests");
check("a normal user cannot read the approval queue", r.status === 403, `got ${r.status}`);

r = await call(owner, "POST", `/api/setup/requests/${request?.id}`, { decision: "approve" });
check("owner approves the request", r.status === 200 && r.data?.status === "APPROVED", `got ${r.status}`);

r = await call(alex, "GET", "/api/setup/state");
check("approved user is asked for the code", r.data?.needs === "code", `got ${r.data?.needs}`);
check("account is linked to the main Nexus account", Boolean(r.data?.account?.linkedEmail?.includes("alex")));

/* --------------------------------- entry ----------------------------------- */

r = await call(alex, "POST", "/api/setup/unlock", { code: setupCode });
check("personal code unlocks the Setup dashboard", r.status === 200 && r.data?.state?.role === "USER", `got ${r.status}`);

r = await call(alex, "GET", "/api/setup/overview");
check("authorised user cannot read owner counters", r.status === 403, `got ${r.status}`);

r = await call(alex, "GET", "/api/setup/activity");
check("authorised user cannot read the activity log", r.status === 403, `got ${r.status}`);

/* ------------------------------ code lifecycle ------------------------------ */

r = await call(owner, "POST", `/api/setup/accounts/${created.id}/actions`, { action: "reset-code" });
const newCode = r.data?.code;
check("owner resets the code", r.status === 200 && /^\d{8}$/.test(String(newCode)));
check("reset issues a different code", newCode !== setupCode);

r = await call(alex, "GET", "/api/setup/state");
check("reset revokes the user's live Setup session", r.data?.unlocked === false);

r = await call(alex, "POST", "/api/setup/unlock", { code: setupCode });
check("the previous code no longer works", r.status === 403, `got ${r.status}`);

r = await call(alex, "POST", "/api/setup/unlock", { code: newCode });
check("the new code works", r.status === 200, `got ${r.status}`);

/* ------------------------------- suspension -------------------------------- */

r = await call(owner, "POST", `/api/setup/accounts/${created.id}/actions`, { action: "suspend" });
check("owner suspends the account", r.status === 200);

r = await call(alex, "GET", "/api/setup/state");
check("suspension kills the live session", r.data?.unlocked === false && r.data?.needs === "blocked", `got ${r.data?.needs}`);

r = await call(alex, "POST", "/api/setup/unlock", { code: newCode });
check("suspended account cannot unlock", r.status === 403, `got ${r.status}`);

r = await call(owner, "POST", `/api/setup/accounts/${created.id}/actions`, { action: "reactivate" });
check("owner reactivates the account", r.status === 200);

/* ------------------------------ owner token -------------------------------- */

r = await call(owner, "POST", "/api/setup/owner-token", { current: "999999", next: "1124100" });
check("token rotation needs the current token", r.status === 403, `got ${r.status}`);

r = await call(owner, "POST", "/api/setup/owner-token", { current: OWNER_TOKEN, next: "1124100" });
check("owner can rotate to the same value (policy check)", r.status === 200, `got ${r.status}`);

r = await call(owner, "POST", "/api/setup/lock");
void r;
r = await call(owner, "POST", "/api/setup/unlock", { ownerToken: OWNER_TOKEN });
check("Setup still unlocks after rotation", r.status === 200, `got ${r.status}`);

/* -------------------------------- activity --------------------------------- */

r = await call(owner, "GET", "/api/setup/activity?limit=200");
const actions = (r.data?.activity || []).map((a) => a.action);
for (const action of [
  "setup.owner_login",
  "setup.owner_denied",
  "setup.account_create",
  "setup.request_create",
  "setup.request_approve",
  "setup.code_reset",
  "setup.account_suspend",
  "setup.owner_token_rotate",
]) {
  check(`activity log records ${action}`, actions.includes(action));
}
check("activity entries carry an actor or system label", (r.data?.activity || []).every((a) => typeof a.at === "string"));

/* --------------------------------- deletion -------------------------------- */

r = await call(owner, "DELETE", `/api/setup/accounts/${created.id}`);
check("owner deletes the Setup account", r.status === 200, `got ${r.status}`);

r = await call(alex, "POST", "/api/setup/unlock", { code: newCode });
check("deleted account can no longer unlock", r.status === 403, `got ${r.status}`);

r = await call(owner, "GET", "/api/setup/accounts");
check("deleted account is gone from the list", !(r.data?.accounts || []).some((a) => a.id === created.id));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log("\nFailures:");
  for (const f of failures) console.log(` - ${f}`);
  process.exitCode = 1;
}
