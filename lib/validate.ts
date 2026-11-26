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
