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
  | "whatsapp.create"
  | "whatsapp.pair"
  | "whatsapp.restart"
  | "whatsapp.logout"
  | "whatsapp.delete"
  | "admin.user_update"
  | "admin.user_delete"
  | "setup.owner_login"
  | "setup.owner_denied"
  | "setup.owner_token_rotate"
  | "setup.login"
  | "setup.lock"
  | "setup.activation_failed"
  | "setup.request_create"
  | "setup.request_approve"
  | "setup.request_reject"
  | "setup.account_create"
  | "setup.account_status"
  | "setup.account_suspend"
  | "setup.account_unlink"
  | "setup.account_delete"
  | "setup.code_reset"
  | "setup.password_reset"
  | "setup.sessions_revoked";

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
