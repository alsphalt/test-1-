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

/* ------------------------------- Darknote Setup ------------------------------ */

export type SetupAccount = {
  id: string;
  username: string;
  displayName: string;
  phone: string;
  status: "INVITED" | "PENDING" | "ACTIVE" | "SUSPENDED" | "REVOKED" | string;
  codePrefix: string;
  codeExpiresAt: string;
  codeDelivery: "NOT_SENT" | "QUEUED" | "SENT" | "FAILED" | string;
  codeDeliveryNote: string;
  linkedUserId: string | null;
  linkedEmail: string | null;
  createdAt: string;
  lastLoginAt: string | null;
  activatedAt: string | null;
};

export type SetupState = {
  ownerEligible: boolean;
  unlocked: boolean;
  role: "OWNER" | "USER" | null;
  needs: "owner_token" | "code" | "activation" | "approval" | "blocked" | "unlocked";
  account: SetupAccount | null;
  ownerEmailsHint: string;
};

export type SetupOverview = {
  generatedAt: string;
  bots: { total: number; paired: number; connected: number; disconnected: number };
  whatsapp: { total: number; connected: number; disconnected: number };
  website: {
    activeSessions: number;
    activeUsers: number;
    sessions: { id: string; ip: string; userAgent: string; lastSeenAt: string; email: string }[];
  };
  setup: { total: number; active: number; suspended: number; pendingRequests: number };
  recentBots: {
    id: string;
    name: string;
    status: string;
    pairedAt: string | null;
    lastSeenAt: string | null;
    email: string;
  }[];
  recentDisconnected: { id: string; label: string; number: string; status: string; at: string; email: string }[];
  audit: { id: string; action: string; target: string; at: string; ip: string; email: string | null }[];
};

export type SetupRequest = {
  id: string;
  status: string;
  createdAt: string;
  decidedAt: string | null;
  requestedBy: { id: string; email: string; name: string } | null;
  account: SetupAccount;
};

export type SetupActivity = {
  id: string;
  action: string;
  target: string;
  meta: Record<string, unknown> | null;
  ip: string;
  at: string;
  email: string | null;
};
