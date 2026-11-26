export type Role = "USER" | "ADMIN";

export type Me = {
  id: string;
  email: string;
  name: string;
  role: Role;
  avatar: string;
  sessionId: string;
  createdAt?: string;
  lastLoginAt?: string | null;
};

export type Counts = {
  bots: number;
  botsOnline: number;
  files: number;
  sessions: number;
  integrations: number;
  logs: number;
  whatsapp?: number;
  whatsappConnected?: number;
};

export type WaStatus =
  | "PAIRING_REQUESTED"
  | "PAIRING_CODE"
  | "CONNECTING"
  | "CONNECTED"
  | "DISCONNECTED"
  | "RECONNECT_REQUESTED"
  | "LOGGED_OUT"
  | "ERROR";

export type WaSession = {
  id: string;
  label: string;
  source: "WORKER" | "BOT";
  botId: string | null;
  botName: string;
  pairError: string;
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

export type MeResponse = { user: Me | null; counts?: Counts };

export type BotStatus = "ONLINE" | "OFFLINE" | "PAUSED" | "ERROR";

export type Bot = {
  id: string;
  name: string;
  description: string;
  status: BotStatus;
  enabled: boolean;
  tokenPrefix: string;
  pairedAt: string | null;
  lastSeenAt: string | null;
  version: string;
  messagesSent: number;
  errors: number;
  createdAt: string;
  updatedAt: string;
  paired: boolean;
};

export type BotLog = {
  id: string;
  level: "INFO" | "WARN" | "ERROR";
  message: string;
  createdAt: string;
  botId?: string;
  bot?: { name: string };
};

export type FileRow = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  createdAt: string;
};

export type Integration = {
  id: string;
  provider: string;
  baseUrl: string;
  headerName: string;
  keyPrefix: string;
  status: "UNTESTED" | "OK" | "FAILED";
  lastTestAt: string | null;
  createdAt: string;
};

export type SessionRow = {
  id: string;
  userAgent: string;
  ip: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  current: boolean;
};

export type AdminUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: "ACTIVE" | "SUSPENDED";
  createdAt: string;
  lastLoginAt: string | null;
  _count?: { bots: number; notes: number; files: number; sessions: number };
};

export type AdminStats = {
  totals: {
    users: number;
    activeSessions: number;
    bots: number;
    botsOnline: number;
    botsEnabled: number;
    notes: number;
    files: number;
    storageBytes: number;
    integrations: number;
  };
  series: {
    days: string[];
    signups: number[];
    activity: { info: number; error: number }[];
  };
  recentAudit: {
    id: string;
    action: string;
    target: string;
    createdAt: string;
    user?: { email: string } | null;
  }[];
};

export type AuditRow = {
  id: string;
  action: string;
  target: string;
  meta: string;
  ip: string;
  createdAt: string;
  user?: { email: string } | null;
};
