/**
 * Origin policy for the browser-facing API.
 *
 * Requests are same-origin by default (the UI calls `/api/...`), but deployments
 * often put the frontend on a preview/custom domain. Those origins must be
 * explicitly allowed — never a wildcard, because the session cookie is sent with
 * `credentials: "include"`.
 *
 *   ALLOWED_ORIGINS="https://darknote.vercel.app,https://preview-*.vercel.app"
 *
 * Exact origins only, except a leading `https://*.` pattern which is allowed
 * when it shares the project's Vercel scope (opt-in, see ALLOW_VERCEL_PREVIEWS).
 */

function normalize(origin: string): string {
  try {
    const url = new URL(origin.trim());
    return url.origin.toLowerCase();
  } catch {
    return "";
  }
}

/** Exact origins from APP_URL + ALLOWED_ORIGINS. */
export function configuredOrigins(): string[] {
  const out = new Set<string>();
  const app = process.env.APP_URL;
  if (app) {
    const norm = normalize(app);
    if (norm) out.add(norm);
  }
  for (const raw of (process.env.ALLOWED_ORIGINS || "").split(/[,\s]+/)) {
    if (!raw || raw.includes("*")) continue; // wildcards are handled separately
    const norm = normalize(raw);
    if (norm) out.add(norm);
  }
  return [...out];
}

/**
 * Hosts this deployment is actually served from. Vercel injects these at build
 * and runtime, so a preview URL works without anyone editing env vars — which
 * is exactly the case that produces "cross-origin request blocked" on signup.
 */
function deploymentHosts(): string[] {
  const keys = [
    "VERCEL_URL",
    "VERCEL_BRANCH_URL",
    "VERCEL_PROJECT_PRODUCTION_URL",
    "NEXT_PUBLIC_APP_URL",
  ];
  const out: string[] = [];
  for (const key of keys) {
    const raw = process.env[key]?.trim().toLowerCase();
    if (!raw) continue;
    out.push(raw.replace(/^https?:\/\//, "").replace(/\/$/, ""));
  }
  return out;
}

function wildcardMatches(origin: string): boolean {
  if (process.env.ALLOW_VERCEL_PREVIEWS !== "true") return false;
  const project = (process.env.VERCEL_PROJECT_PRODUCTION_URL || "").toLowerCase();
  if (!project) return false;
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return host.endsWith(".vercel.app") && host.startsWith(project.split(".")[0]);
  } catch {
    return false;
  }
}

function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

/** True when the request may read/write with credentials. */
export function isAllowedOrigin(origin: string | null, host: string | null): boolean {
  if (!origin) return true; // curl, server-to-server, same-origin navigations
  const normalized = normalize(origin);
  if (!normalized) return false;

  let originHost = "";
  try {
    originHost = new URL(normalized).host;
  } catch {
    return false;
  }

  if (host && originHost === host) return true;
  if (deploymentHosts().includes(originHost)) return true;
  if (configuredOrigins().includes(normalized)) return true;
  if (wildcardMatches(normalized)) return true;

  // Local development: the UI often runs on :3000 while the API runs on :3210.
  if (process.env.NODE_ENV !== "production") {
    const originUrl = new URL(normalized);
    if (isLocalHost(originUrl.hostname) && host && isLocalHost(host.split(":")[0])) return true;
  }

  return false;
}

export function corsHeadersFor(origin: string | null, host: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    Vary: "Origin, Access-Control-Request-Headers",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "content-type,authorization,x-requested-with,x-csrf-token",
    "Access-Control-Max-Age": "600",
  };
  if (origin && isAllowedOrigin(origin, host)) {
    // Echo the exact origin: never "*" together with credentials.
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Credentials"] = "true";
  }
  return headers;
}
