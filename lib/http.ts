import { NextResponse } from "next/server";
import { isAllowedOrigin } from "./origin";
import { ZodError } from "zod";

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (msg: string, details?: unknown) =>
  new ApiError(400, "BAD_REQUEST", msg, details);
export const unauthorized = (msg = "Authentication required") =>
  new ApiError(401, "UNAUTHORIZED", msg);
export const forbidden = (msg = "You do not have access to this resource") =>
  new ApiError(403, "FORBIDDEN", msg);
export const notFound = (msg = "Not found") => new ApiError(404, "NOT_FOUND", msg);
export const conflict = (msg: string) => new ApiError(409, "CONFLICT", msg);
export const tooMany = (retryAfter: number) =>
  new ApiError(429, "RATE_LIMITED", `Too many requests. Try again in ${retryAfter}s.`);

export function json<T>(data: T, status = 200, headers?: Record<string, string>) {
  return NextResponse.json(data, {
    status,
    headers: { "Cache-Control": "no-store", ...(headers || {}) },
  });
}

/** Wraps a route handler with uniform error handling. */
export function route<Args extends unknown[]>(
  fn: (...args: Args) => Promise<NextResponse | Response>,
) {
  return async (...args: Args): Promise<NextResponse | Response> => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof ApiError) {
        return json(
          { error: { code: err.code, message: err.message, details: err.details ?? null } },
          err.status,
        );
      }
      if (err instanceof ZodError) {
        return json(
          {
            error: {
              code: "VALIDATION_ERROR",
              message: "Please check the highlighted fields.",
              details: err.flatten(),
            },
          },
          422,
        );
      }
      console.error("[api] unhandled", err);
      return json(
        { error: { code: "INTERNAL", message: "Something went wrong. Please try again." } },
        500,
      );
    }
  };
}

export function clientIp(req: Request): string {
  const h = req.headers;
  return (
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    h.get("x-real-ip") ||
    "127.0.0.1"
  );
}

/* --------------------------- in-memory rate limit -------------------------- */

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

export function rateLimit(key: string, limit: number, windowMs: number): void {
  const now = Date.now();
  const existing = buckets.get(key);

  if (buckets.size > 5000) {
    for (const [k, b] of buckets) if (b.resetAt < now) buckets.delete(k);
  }

  if (!existing || existing.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  existing.count += 1;
  if (existing.count > limit) {
    throw tooMany(Math.max(1, Math.ceil((existing.resetAt - now) / 1000)));
  }
}

/**
 * CSRF defence: state-changing requests must come from the same origin.
 * Browsers always send Origin on cross-site POST/PATCH/DELETE.
 */
export function assertSameOrigin(req: Request): void {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;

  const origin = req.headers.get("origin");
  if (!origin) return; // non-browser client (curl, bot heartbeat) — auth still applies

  const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
  if (!isAllowedOrigin(origin, host)) {
    throw new ApiError(
      403,
      "CROSS_ORIGIN",
      `This origin is not allowed to call the API. Add ${new URL(origin).origin} to ALLOWED_ORIGINS, or call the API through the same domain (/api).`,
    );
  }
}

export async function readJson<T>(req: Request): Promise<T> {
  const type = req.headers.get("content-type") || "";
  if (!type.includes("application/json")) {
    throw badRequest("Expected application/json body");
  }
  try {
    return (await req.json()) as T;
  } catch {
    throw badRequest("Malformed JSON body");
  }
}
