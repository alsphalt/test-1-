/** Shared WhatsApp session helpers (web + API). The worker mirrors the statuses. */

export const WA_STATUSES = [
  "PAIRING_REQUESTED",
  "PAIRING_CODE",
  "CONNECTING",
  "CONNECTED",
  "DISCONNECTED",
  "RECONNECT_REQUESTED",
  "LOGGED_OUT",
  "ERROR",
] as const;

export type WaStatus = (typeof WA_STATUSES)[number];

export const WA_STATUS_LABEL: Record<WaStatus, string> = {
  PAIRING_REQUESTED: "Preparing",
  PAIRING_CODE: "Enter code",
  CONNECTING: "Connecting",
  CONNECTED: "Connected",
  DISCONNECTED: "Disconnected",
  RECONNECT_REQUESTED: "Restarting",
  LOGGED_OUT: "Logged out",
  ERROR: "Error",
};

/** Digits only, 8–15 chars, no leading zero (E.164 style). */
export function normalizePhone(input: string): string {
  return (input || "").replace(/[^\d]/g, "").replace(/^0+/, "");
}

export function isValidPhone(digits: string): boolean {
  return /^[1-9]\d{7,14}$/.test(digits);
}

export function prettyPhone(value: string): string {
  const digits = (value || "").replace(/[^\d]/g, "");
  if (!digits) return "—";
  return `+${digits}`;
}

export function uptimeSeconds(connectedAt?: Date | string | null, now = Date.now()): number {
  if (!connectedAt) return 0;
  const started = new Date(connectedAt).getTime();
  if (Number.isNaN(started)) return 0;
  return Math.max(0, Math.floor((now - started) / 1000));
}

export function formatUptime(totalSeconds: number): string {
  if (!totalSeconds) return "—";
  const d = Math.floor(totalSeconds / 86_400);
  const h = Math.floor((totalSeconds % 86_400) / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

/** The worker refreshes lastSeenAt every 15s; older than 90s means it is gone. */
export function isWorkerLive(status: string, lastSeenAt?: Date | string | null): boolean {
  if (status !== "CONNECTED" && status !== "PAIRING_CODE" && status !== "CONNECTING") return false;
  if (!lastSeenAt) return false;
  return Date.now() - new Date(lastSeenAt).getTime() < 90_000;
}

export type PublicSession = {
  id: string;
  label: string;
  phone: string;
  prettyPhone: string;
  status: WaStatus;
  statusLabel: string;
  statusDetail: string;
  pairingCode: string;
  pairingExpiresAt: string | null;
  pairingSecondsLeft: number;
  meJid: string;
  meNumber: string;
  platform: string;
  connectedAt: string | null;
  lastSeenAt: string | null;
  uptimeSeconds: number;
  disconnectCount: number;
  workerLive: boolean;
  logCount?: number;
  createdAt: string;
  updatedAt: string;
};

type SessionRow = {
  id: string;
  label: string;
  phone: string;
  status: string;
  statusDetail: string;
  pairingCode: string;
  pairingExpiresAt: Date | null;
  meJid: string;
  meNumber: string;
  platform: string;
  connectedAt: Date | null;
  lastSeenAt: Date | null;
  disconnectCount: number;
  createdAt: Date;
  updatedAt: Date;
  _count?: { logs: number };
};

export function toPublicSession(row: SessionRow): PublicSession {
  const status = (WA_STATUSES as readonly string[]).includes(row.status)
    ? (row.status as WaStatus)
    : "ERROR";
  const expires = row.pairingExpiresAt ? row.pairingExpiresAt.getTime() : 0;
  const secondsLeft = expires ? Math.max(0, Math.floor((expires - Date.now()) / 1000)) : 0;

  return {
    id: row.id,
    label: row.label,
    phone: row.phone,
    prettyPhone: prettyPhone(row.phone || row.meNumber),
    status,
    statusLabel: WA_STATUS_LABEL[status],
    statusDetail: row.statusDetail,
    pairingCode: secondsLeft > 0 ? row.pairingCode : "",
    pairingExpiresAt: row.pairingExpiresAt ? row.pairingExpiresAt.toISOString() : null,
    pairingSecondsLeft: secondsLeft,
    meJid: row.meJid,
    meNumber: row.meNumber,
    platform: row.platform,
    connectedAt: row.connectedAt ? row.connectedAt.toISOString() : null,
    lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
    uptimeSeconds: uptimeSeconds(row.connectedAt),
    disconnectCount: row.disconnectCount,
    workerLive: isWorkerLive(row.status, row.lastSeenAt),
    logCount: row._count?.logs,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
