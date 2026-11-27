import { z } from "zod";

const email = z.string().trim().toLowerCase().email("Enter a valid email address").max(254);

const password = z
  .string()
  .min(10, "Use at least 10 characters")
  .max(200, "That password is too long")
  .refine((v) => /[a-zA-Z]/.test(v) && /[0-9]/.test(v), "Include at least one letter and one number");

export const registerSchema = z.object({
  name: z.string().trim().min(2, "Name is too short").max(60, "Name is too long"),
  email,
  password,
});

export const loginSchema = z.object({
  email,
  password: z.string().min(1, "Password is required").max(200),
});

export const noteCreateSchema = z.object({
  title: z.string().max(200).default(""),
  body: z.string().max(100_000).default(""),
});

export const noteUpdateSchema = z
  .object({
    title: z.string().max(200).optional(),
    body: z.string().max(100_000).optional(),
    pinned: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");

export const profileUpdateSchema = z
  .object({
    name: z.string().trim().min(2, "Name is too short").max(60, "Name is too long").optional(),
    avatar: z.string().trim().max(16, "Pick a shorter avatar").optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");

export const whatsappCreateSchema = z.object({
  label: z.string().trim().min(2, "Give the session a name").max(60, "Name is too long"),
  botId: z.string().trim().max(40).optional(),
  phone: z
    .string()
    .trim()
    .min(8, "Enter the full international number")
    .max(20)
    .transform((v) => v.replace(/[^\d]/g, "").replace(/^0+/, ""))
    .refine((v) => /^[1-9]\d{7,14}$/.test(v), "Use the international format, e.g. 447700900123"),
});

export const botSyncSchema = z.object({
  status: z.enum(["ONLINE", "OFFLINE", "PAUSED", "ERROR"]).default("ONLINE"),
  version: z.string().max(40).optional(),
  message: z.string().max(300).optional(),
  messagesSent: z.number().int().min(0).optional(),
  errors: z.number().int().min(0).optional(),
  sessions: z
    .array(
      z.object({
        externalId: z.string().min(1).max(120),
        label: z.string().max(60).optional(),
        phone: z.string().max(20).default(""),
        status: z.string().max(24),
        statusDetail: z.string().max(300).optional(),
        meNumber: z.string().max(24).optional(),
        meJid: z.string().max(140).optional(),
        platform: z.string().max(40).optional(),
        connectedAt: z.string().datetime().optional(),
        pairingCode: z.string().max(16).optional(),
      }),
    )
    .max(50)
    .default([]),
});

export const botPairResultSchema = z
  .object({
    code: z.string().trim().max(16).optional(),
    error: z.string().trim().max(300).optional(),
    phone: z.string().trim().max(20).optional(),
    expiresAt: z.string().datetime().optional(),
  })
  .refine((v) => Boolean(v.code) !== Boolean(v.error), "Send either code or error");

export const botEventsSchema = z.object({
  events: z
    .array(
      z.object({
        level: z.enum(["INFO", "WARN", "ERROR"]).default("INFO"),
        message: z.string().min(1).max(500),
        sessionId: z.string().max(60).optional(),
      }),
    )
    .max(50),
});

export const botCommandResultSchema = z.object({
  status: z.enum(["DONE", "ERROR"]),
  result: z.string().max(300).optional(),
});

export const botCreateSchema = z.object({
  name: z.string().trim().min(2, "Name is too short").max(60).default("New bot"),
  description: z.string().trim().max(300).default(""),
});

export const botUpdateSchema = z
  .object({
    name: z.string().trim().min(2).max(60).optional(),
    description: z.string().trim().max(300).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");

export const pairConsumeSchema = z.object({
  code: z.string().trim().length(8, "Pairing codes are 8 characters").toUpperCase(),
  version: z.string().trim().max(40).optional(),
});

export const heartbeatSchema = z.object({
  status: z.enum(["ONLINE", "OFFLINE", "PAUSED", "ERROR"]).default("ONLINE"),
  message: z.string().max(500).optional(),
  version: z.string().max(40).optional(),
  messagesSent: z.number().int().min(0).max(1_000_000).optional(),
  errors: z.number().int().min(0).max(1_000_000).optional(),
});

export const integrationCreateSchema = z.object({
  provider: z.string().trim().min(1, "Name the integration").max(40),
  baseUrl: z
    .string()
    .trim()
    .url("Enter a full URL, e.g. https://api.example.com/health")
    .refine((v) => v.startsWith("https://") || v.startsWith("http://"), "Use http(s)"),
  headerName: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]{2,40}$/, "Use a valid header name")
    .default("Authorization"),
  apiKey: z.string().trim().min(8, "That key looks too short").max(500),
});

export const adminUserPatchSchema = z
  .object({
    role: z.enum(["USER", "ADMIN"]).optional(),
    status: z.enum(["ACTIVE", "SUSPENDED"]).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;

/* ------------------------------- Darknote Setup ------------------------------ */

const setupUsername = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, "Username is too short")
  .max(32, "Username is too long")
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "Use letters, numbers, dot, dash or underscore");

const setupCode = z
  .string()
  .trim()
  .regex(/^\d{6,12}$/, "Enter the numeric setup code");

export const setupActivateSchema = z.object({
  username: setupUsername,
  password: z.string().min(1, "Password is required").max(200),
  code: setupCode,
});

export const setupUnlockSchema = z
  .object({
    code: setupCode.optional(),
    ownerToken: z.string().trim().min(1).max(128).optional(),
  })
  .refine((v) => Boolean(v.code || v.ownerToken), "Enter your setup code or the owner token");

export const setupAccountCreateSchema = z.object({
  username: setupUsername,
  password,
  phone: z.string().trim().min(7, "Enter a phone number with country code").max(24),
  displayName: z.string().trim().max(60).optional(),
  mainEmail: z.string().trim().toLowerCase().email("Enter a valid email").max(254).optional().or(z.literal("")),
});

export const setupAccountActionSchema = z.object({
  action: z.enum([
    "reset-code",
    "reset-password",
    "suspend",
    "reactivate",
    "unlink",
    "revoke-sessions",
    "delete",
  ]),
  password: z.string().min(1).max(200).optional(),
});

export const setupDecisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
});

export const ownerTokenRotateSchema = z.object({
  current: z.string().min(1).max(128),
  next: z.string().min(6, "Use at least 6 characters").max(72),
});
