import { NextResponse, type NextRequest } from "next/server";
import { corsHeadersFor, corsRejectionHeaders, frameHeaders, isAllowedOrigin } from "@/lib/origin";
import { logEvent } from "@/lib/log";

/**
 * Security headers + CORS for the browser API.
 *
 * Same-origin is the default path (`fetch("/api/...")`), so CORS only applies
 * when an origin was explicitly allowed. Credentialed CORS never uses a
 * wildcard: the exact origin is echoed back.
 *
 * A rejected cross-origin request still gets `Access-Control-Allow-Origin`
 * (without credentials) so the browser can read the explanation instead of
 * showing only "cross-origin request blocked".
 */
export function middleware(req: NextRequest) {
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
  const selfOrigin = req.nextUrl.origin;
  const isApi = req.nextUrl.pathname.startsWith("/api/");
  const isAuthSurface =
    isApi ||
    req.nextUrl.pathname === "/" ||
    req.nextUrl.pathname.startsWith("/login") ||
    req.nextUrl.pathname.startsWith("/register");

  // Preflight: answer here so the route handler never sees OPTIONS.
  if (isApi && req.method === "OPTIONS") {
    return new NextResponse(null, {
      status: 204,
      headers: corsHeadersFor(origin, host, selfOrigin, {
        requestMethod: req.headers.get("access-control-request-method"),
        requestHeaders: req.headers.get("access-control-request-headers"),
      }),
    });
  }

  // Fail closed for an explicitly disallowed origin on state-changing calls.
  if (isAuthSurface && origin && !isAllowedOrigin(origin, host, selfOrigin) && req.method !== "GET" && req.method !== "HEAD") {
    logEvent("warn", "cors.rejected", {
      origin,
      host: host ?? null,
      selfOrigin,
      method: req.method,
      path: req.nextUrl.pathname,
    });

    return NextResponse.json(
      {
        error: {
          code: "CROSS_ORIGIN",
          message: `This origin is not allowed to call the API. Add ${origin} to ALLOWED_ORIGINS, or call the API through the same domain (/api).`,
        },
      },
      { status: 403, headers: corsRejectionHeaders(origin) },
    );
  }

  const res = NextResponse.next();

  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.headers.set("X-DNS-Prefetch-Control", "off");
  for (const [key, value] of Object.entries(frameHeaders())) {
    res.headers.set(key, value);
  }

  if (isApi) {
    res.headers.set("Cache-Control", "no-store, max-age=0");
    for (const [key, value] of Object.entries(corsHeadersFor(origin, host, selfOrigin))) {
      res.headers.set(key, value);
    }
  }

  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
