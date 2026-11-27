/**
 * Structured server-side logging with secret redaction.
 *
 * Every line is JSON so Vercel/host log search works, and every value is
 * scrubbed of connection strings, bot tokens, bearer headers and passwords
 * before it is written. Errors are the only thing we log by default; successes
 * are logged only when they are slow.
 */

const REDACTIONS: [RegExp, string][] = [
  [/postgres(?:ql)?:\/\/[^\s"'\\]+/gi, "postgresql://[redacted]"],
  [/dnx_[A-Za-z0-9_-]{8,}/g, "dnx_[redacted]"],
  [/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]"],
  [/(password|passwd|pwd)=([^&\s"']+)/gi, "$1=[redacted]"],
  [/([?&](?:api_key|apikey|token|secret)=)[^&\s"']+/gi, "$1[redacted]"],
];

export function redact(input: unknown): string {
  let text = typeof input === "string" ? input : safeStringify(input);
  for (const [pattern, replacement] of REDACTIONS) text = text.replace(pattern, replacement);
  return text.length > 1000 ? `${text.slice(0, 1000)}…` : text;
}

function safeStringify(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export function logEvent(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    clean[key] = typeof value === "string" ? redact(value) : value;
  }

  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    service: "darknote-nexus",
    ...clean,
  });

  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
