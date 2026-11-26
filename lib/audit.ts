import { prisma } from "./db";

export type AuditAction =
  | "auth.register"
  | "auth.login"
  | "auth.login_failed"
  | "auth.logout"
  | "auth.session_revoked"
  | "note.create"
  | "note.update"
  | "note.delete"
  | "bot.create"
  | "bot.update"
  | "bot.delete"
  | "bot.pair_code"
  | "bot.pair"
  | "bot.revoke"
  | "file.upload"
  | "file.delete"
  | "integration.create"
  | "integration.delete"
  | "integration.test"
  | "user.update"
  | "admin.user_update"
  | "admin.user_delete";

export async function audit(params: {
  userId?: string | null;
  action: AuditAction;
  target?: string;
  meta?: Record<string, unknown>;
  ip?: string;
}): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: params.userId ?? null,
        action: params.action,
        target: params.target ?? "",
        meta: params.meta ? JSON.stringify(params.meta) : "",
        ip: params.ip ?? "",
      },
    });
  } catch (err) {
    // Auditing must never break the request it is recording.
    console.error("[audit] failed", params.action, err);
  }
}
