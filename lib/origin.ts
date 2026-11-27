/**
 * Origin policy for the browser-facing API.
 *
 * Requests are same-origin by default (the UI calls `/api/...`). Deployments
 * that put the UI on a preview/custom domain must allow that origin explicitly —
 * never a wildcard, because the session cookie travels with the request.
 *
 * Trusted origins are, in order:
 *   1. the origin this request was actually served from (`req.nextUrl.origin`),
 *   2. the `Host` / `X-Forwarded-Host` being requested,
 *   3. `APP_URL`,
 *   4. exact entries in `ALLOWED_ORIGINS`,
 *   5. this deployment's own Vercel hosts (VERCEL_URL etc.),
 *   6. `*.vercel.app` in the same project when ALLOW_VERCEL_PREVIEWS=true.
 */

function normalize(origin: string): string {
  try {
    return new URL(origin.trim()).origin.toLowerCase();
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
 * is exactly the case that produces a cross-origin failure on signup.
 */
function deploymentHosts(): string[] {
  const keys = ["VERCEL_URL", "VERCEL_BRANCH_URL", "VERCEL_PROJECT_PRODUCTION_URL", "NEXT_PUBLIC_APP_URL"];
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

/**
 * True when the request may read/write with credentials.
 *
 * `selfOrigin` is the origin the request was served from. Behind a proxy the
 * `Host` header can be an internal address, which used to reject the app's own
 * origin and surface as a misleading "cross-origin" error.
 */
export function isAllowedOrigin(
  origin: string | null,
  host: string | null,
  selfOrigin?: string | null,
): boolean {
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
  if (selfOrigin && normalize(selfOrigin) === normalized) return true;
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

const DEFAULT_METHODS = "GET,POST,PATCH,DELETE,OPTIONS";
const DEFAULT_HEADERS = "content-type,authorization,x-requested-with,x-csrf-token";

/**
 * CORS headers.
 *
 * `preflight` reflects the method/headers the browser asked for (bounded to our
 * allowlists) so a request carrying an extra header is not rejected for an
 * avoidable reason.
 */
export function corsHeadersFor(
  origin: string | null,
  host: string | null,
  selfOrigin?: string | null,
  preflight?: { requestMethod?: string | null; requestHeaders?: string | null },
): Record<string, string> {
  const headers: Record<string, string> = {
    Vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
    "Access-Control-Allow-Methods": DEFAULT_METHODS,
    "Access-Control-Allow-Headers": DEFAULT_HEADERS,
    "Access-Control-Max-Age": "600",
  };

  const requestedMethod = preflight?.requestMethod?.toUpperCase();
  if (requestedMethod && DEFAULT_METHODS.split(",").includes(requestedMethod)) {
    headers["Access-Control-Allow-Methods"] = requestedMethod;
  }

  const requestedHeaders = preflight?.requestHeaders;
  if (requestedHeaders) {
    // Reflecting the request is not a grant: the request itself is authorised
    // separately, and credentials are only issued for an allowed origin.
    headers["Access-Control-Allow-Headers"] = requestedHeaders.toLowerCase();
  }

  if (origin && isAllowedOrigin(origin, host, selfOrigin)) {
    // Echo the exact origin: never "*" together with credentials.
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Credentials"] = "true";
  }
  return headers;
}

/**
 * Headers for a rejected cross-origin request.
 *
 * Without `Access-Control-Allow-Origin` the browser discards the body, so the
 * developer sees only "cross-origin request blocked" in DevTools and never the
 * reason. Echoing the origin makes the rejection readable. Credentials are
 * deliberately NOT granted: the request was refused and the body contains only
 * a code and the fix.
 */
export function corsRejectionHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    Vary: "Origin",
    "Cache-Control": "no-store",
  };
  if (origin) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

/** Frame policy. v0 previews render the app inside an iframe on another origin. */
export function frameHeaders(): Record<string, string> {
  const raw = (process.env.FRAME_ANCESTORS || "'self'").trim();
  if (raw === "'self'") {
    return { "X-Frame-Options": "DENY" };
  }
  // X-Frame-Options cannot express a list, so a multi-origin policy must use CSP.
  return { "Content-Security-Policy": `frame-ancestors ${raw}` };
}
