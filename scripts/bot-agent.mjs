#!/usr/bin/env node
/**
 * Reference connector. Pairs once with a code from the dashboard, then sends
 * heartbeats so the UI shows the bot as ONLINE with live log lines.
 *
 *   node scripts/bot-agent.mjs --url https://your-app.vercel.app --code ABC12345
 *   node scripts/bot-agent.mjs --url http://localhost:3000 --token dnx_xxx --interval 10
 *
 * The token is written to .bot-token.json (gitignored) so restarts do not need a new code.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
const get = (flag, fallback = "") => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const base = get("--url", process.env.NEXUS_URL || "http://localhost:3000").replace(/\/$/, "");
const code = get("--code");
const interval = Math.max(3, Number(get("--interval", "15")));
const version = get("--version", "1.0.0");
const TOKEN_FILE = ".bot-token.json";

let token = get("--token") || (existsSync(TOKEN_FILE) ? JSON.parse(readFileSync(TOKEN_FILE, "utf8")).token : "");
let botName = "";
let sent = 0;

function log(message) {
  const time = new Date().toISOString().slice(11, 19);
  console.log(`[${time}] ${message}`);
}

async function pair() {
  if (!code) return false;
  log(`pairing with ${base} …`);
  const res = await fetch(`${base}/api/bots/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, version }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    log(`pairing failed: ${body?.error?.message || res.status}`);
    return false;
  }
  token = body.token;
  botName = body.name;
  writeFileSync(TOKEN_FILE, JSON.stringify({ token, botId: body.botId, at: new Date().toISOString() }, null, 2));
  log(`paired as "${body.name}" — token stored in ${TOKEN_FILE}`);
  return true;
}

async function beat(status = "ONLINE", message = "") {
  sent += 1;
  const res = await fetch(`${base}/api/bots/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      status,
      version,
      messagesSent: sent,
      errors: 0,
      message: message || `heartbeat #${sent}`,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    log(`heartbeat rejected (${res.status}): ${body?.error?.message || "unknown"}`);
    if (res.status === 401) process.exitCode = 1;
    return false;
  }
  log(`heartbeat #${sent} ok · server ${new Date(body.serverTime).toLocaleTimeString()}`);
  return true;
}

(async () => {
  if (!token && !(await pair())) {
    console.error("No token. Pass --code <pairing code> from the dashboard.");
    process.exit(1);
  }
  log(`reporting to ${base} every ${interval}s${botName ? ` as ${botName}` : ""}`);
  await beat("ONLINE", "connector started");
  setInterval(() => {
    void beat("ONLINE");
  }, interval * 1000);
})();
