"use client";

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  hint?: string;

  constructor(status: number, code: string, message: string, details?: unknown, hint?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.hint = hint;
  }
}

type ErrorBody = { error?: { code?: string; message?: string; details?: unknown; hint?: string | null } };

/**
 * Same-origin by default. Set NEXT_PUBLIC_API_BASE only when the UI is deployed
 * apart from the API; that origin must also be in the server's ALLOWED_ORIGINS.
 */
/**
 * Resolved per call: if NEXT_PUBLIC_API_BASE points at this same origin it is
 * ignored, so the request stays same-origin and never enters CORS at all.
 */
function apiBase(): string {
  const configured = (process.env.NEXT_PUBLIC_API_BASE || "").trim().replace(/\/$/, "");
  if (!configured) return "";
  if (typeof window !== "undefined") {
    try {
      if (new URL(configured).origin === window.location.origin) return "";
    } catch {
      return "";
    }
  }
  return configured;
}

function url(path: string): string {
  const base = apiBase();
  if (!base) return path;
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  let payload: BodyInit | undefined;

  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  let res: Response;
  try {
    res = await fetch(url(path), {
      method,
      headers,
      body: payload,
      credentials: apiBase() ? "include" : "same-origin",
      cache: "no-store",
    });
  } catch {
    const base = apiBase();
    throw new ApiError(
      0,
      "NETWORK",
      base
        ? `Cannot reach the API at ${base}. The browser may be blocking a cross-origin request: add this page's origin to ALLOWED_ORIGINS on the API, and set COOKIE_SAMESITE=none over HTTPS for the session cookie.`
        : "Cannot reach the API. Check your connection and that the server is running.",
    );
  }

  const contentType = res.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await res.json() : null;

  if (res.status === 401 && !path.startsWith("/api/auth/login") && !path.startsWith("/api/auth/me")) {
    window.dispatchEvent(new Event("dnx:unauthorized"));
  }

  if (!res.ok) {
    const err = (data || {}) as ErrorBody;
    throw new ApiError(
      res.status,
      err.error?.code || "REQUEST_FAILED",
      err.error?.message || `Request failed (${res.status})`,
      err.error?.details,
      err.error?.hint ?? undefined,
    );
  }

  return data as T;
}

export const api = {
  get: <T,>(path: string) => request<T>("GET", path),
  post: <T,>(path: string, body?: unknown) => request<T>("POST", path, body),
  patch: <T,>(path: string, body?: unknown) => request<T>("PATCH", path, body),
  del: <T,>(path: string) => request<T>("DELETE", path),
};

export function errorMessage(err: unknown): string {
  // Hints are for operators (server logs, /api/health). Users see the message
  // only, so internal configuration details never reach the browser.
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

export function fieldErrors(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError)) return {};
  const details = err.details as { fieldErrors?: Record<string, string[]> } | undefined;
  const out: Record<string, string> = {};
  if (details?.fieldErrors) {
    for (const [key, messages] of Object.entries(details.fieldErrors)) {
      if (messages && messages.length) out[key] = messages[0];
    }
  }
  return out;
}
