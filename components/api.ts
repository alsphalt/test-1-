"use client";

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

type ErrorBody = { error?: { code?: string; message?: string; details?: unknown } };

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  let payload: BodyInit | undefined;

  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const res = await fetch(path, {
    method,
    headers,
    body: payload,
    credentials: "same-origin",
    cache: "no-store",
  });

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
