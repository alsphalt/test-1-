import { NextResponse, type NextRequest } from "next/server";
import { corsHeadersFor, isAllowedOrigin } from "@/lib/origin";

/**
 * Security headers + CORS for the browser API.
 *
 * Same-origin is the default path (`fetch("/api/...")`), so this only adds CORS
 * for origins that were explicitly configured. Credentialed CORS never uses a
 * wildcard: the exact origin is echoed back, and disallowed origins get no
 * Access-Control-* grant at all.
 */
export function middleware(req: NextRequest) {
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
  const isApi = req.nextUrl.pathname.startsWith("/api/");
  const isAuthSurface =
    isApi ||
    req.nextUrl.pathname === "/" ||
    req.nextUrl.pathname.startsWith("/login") ||
    req.nextUrl.pathname.startsWith("/register");

  // Fail closed for an explicitly disallowed origin on state-changing calls.
  if (isAuthSurface && origin && !isAllowedOrigin(origin, host) && req.method !== "GET" && req.method !== "HEAD") {
    return NextResponse.json(
      {
        error: {
          code: "CROSS_ORIGIN",
          message: `This origin is not allowed to call the API. Add ${origin} to ALLOWED_ORIGINS or use the same domain.`,
        },
      },
      { status: 403, headers: { Vary: "Origin", "Cache-Control": "no-store" } },
    );
  }

  // Preflight: answer here so the route handler never sees OPTIONS.
  if (isApi && req.method === "OPTIONS") {
    return new NextResponse(null, { status: 204, headers: corsHeadersFor(origin, host) });
  }

  const res = NextResponse.next();

  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.headers.set("X-DNS-Prefetch-Control", "off");

  if (isApi) {
    res.headers.set("Cache-Control", "no-store, max-age=0");
    for (const [key, value] of Object.entries(corsHeadersFor(origin, host))) {
      res.headers.set(key, value);
    }
  }

  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
