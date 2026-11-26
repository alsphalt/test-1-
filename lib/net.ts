/**
 * Minimal SSRF guard for user-supplied integration URLs.
 * Blocks loopback, link-local and RFC1918 targets before we ever fetch.
 */
const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^0\./,
];

export function assertPublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid URL");
  }

  if (!/^https?:$/.test(url.protocol)) throw new Error("Only http and https are allowed");

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new Error("That host is not reachable from the server");
  }
  if (host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) {
    throw new Error("That host is not reachable from the server");
  }
  if (PRIVATE_V4.some((re) => re.test(host))) {
    throw new Error("Private network addresses are not allowed");
  }
  return url;
}
