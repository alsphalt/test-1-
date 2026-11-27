import { Prisma } from "@prisma/client";

/**
 * Turns infrastructure failures into actionable API errors.
 *
 * The old behaviour collapsed every unexpected exception into
 * "Something went wrong. Please try again.", which made a missing AUTH_SECRET
 * indistinguishable from an unreachable database. These messages name the
 * failing component and the fix; they never include secrets, connection
 * strings, query text or stack traces.
 */

export type Diagnosed = {
  status: number;
  code: string;
  message: string;
  /** Safe, non-secret hint for the deployment operator. */
  hint?: string;
  /** What to print server-side (the raw error is logged separately). */
  log: string;
};

const PRISMA_UNREACHABLE = new Set([
  "P1001", // cannot reach database server
  "P1002", // timed out
  "P1008", // operation timed out
  "P1017", // server closed the connection
  "P2024", // pool timeout
]);

const PRISMA_BAD_CREDENTIALS = new Set([
  "P1000", // authentication failed
  "P1010", // access denied
]);

const PRISMA_NO_DATABASE = new Set(["P1003"]);

const PRISMA_SCHEMA = new Set([
  "P2021", // table does not exist
  "P2022", // column does not exist
  "P3005", // database schema is not empty (migrations out of sync)
  "P3009", // failed migrations
]);

function configError(message: string): Diagnosed | null {
  if (/AUTH_SECRET is not configured/i.test(message)) {
    return {
      status: 503,
      code: "SERVER_MISCONFIGURED",
      message: "The server is missing AUTH_SECRET, so it cannot sign session cookies.",
      hint: "Set AUTH_SECRET (32+ random characters) in the deployment environment, then redeploy.",
      log: "AUTH_SECRET missing",
    };
  }
  if (/AUTH_SECRET must be at least 32 characters/i.test(message)) {
    return {
      status: 503,
      code: "SERVER_MISCONFIGURED",
      message: "AUTH_SECRET is too short for production (minimum 32 characters).",
      hint: "Generate one with: openssl rand -base64 48",
      log: "AUTH_SECRET too short",
    };
  }
  if (/ENCRYPTION_KEY is not configured/i.test(message)) {
    return {
      status: 503,
      code: "SERVER_MISCONFIGURED",
      message: "The server is missing ENCRYPTION_KEY, so stored secrets cannot be decrypted.",
      hint: "Set ENCRYPTION_KEY to 32 bytes as 64 hex characters, then redeploy.",
      log: "ENCRYPTION_KEY missing",
    };
  }
  if (/ENCRYPTION_KEY must be 32 bytes/i.test(message)) {
    return {
      status: 503,
      code: "SERVER_MISCONFIGURED",
      message: "ENCRYPTION_KEY is not 32 bytes.",
      hint: "Generate one with: openssl rand -hex 32",
      log: "ENCRYPTION_KEY invalid",
    };
  }
  if (/AUTH_SECRET and ENCRYPTION_KEY must not be the same value/i.test(message)) {
    return {
      status: 503,
      code: "SERVER_MISCONFIGURED",
      message: "AUTH_SECRET and ENCRYPTION_KEY are the same value.",
      hint: "Use two independent random values: openssl rand -base64 48 for AUTH_SECRET and openssl rand -hex 32 for ENCRYPTION_KEY.",
      log: "AUTH_SECRET === ENCRYPTION_KEY",
    };
  }
  if (/(AUTH_SECRET|ENCRYPTION_KEY) is still the example placeholder/i.test(message)) {
    return {
      status: 503,
      code: "SERVER_MISCONFIGURED",
      message: "A secret is still set to the example placeholder value.",
      hint: "Replace it with a freshly generated random value, then redeploy.",
      log: "Secret is a placeholder",
    };
  }
  /**
   * AES-GCM authentication failure. Either the value was written with a
   * different ENCRYPTION_KEY (rotated, or a per-scope variable that differs
   * between Production and Preview) or the stored ciphertext is damaged.
   * Saying so is safe: it reveals no key material.
   */
  if (
    /unable to authenticate data|unsupported state or unable to authenticate|bad decrypt|Malformed ciphertext/i.test(
      message,
    )
  ) {
    return {
      status: 503,
      code: "SECRETS_UNREADABLE",
      message: "Stored encrypted values cannot be decrypted with the current ENCRYPTION_KEY.",
      hint: "The key changed after the values were saved. Restore the previous ENCRYPTION_KEY, or re-enter the stored integration keys.",
      log: "ENCRYPTION_KEY does not match stored ciphertext",
    };
  }
  return null;
}

export function diagnose(err: unknown): Diagnosed {
  const raw = err instanceof Error ? err.message : String(err);
  const fromConfig = configError(raw);
  if (fromConfig) return fromConfig;

  if (/Environment variable not found:\s*DATABASE_URL/i.test(raw)) {
    return {
      status: 503,
      code: "DATABASE_URL_MISSING",
      message: "The server is not configured with a database URL.",
      hint: "Set DATABASE_URL in the deployment environment for this scope (Production, not only Preview), then redeploy.",
      log: "DATABASE_URL missing",
    };
  }

  if (/the URL must start with the protocol `?(file|postgresql|postgres):/i.test(raw)) {
    return {
      status: 503,
      code: "DATABASE_CLIENT_MISMATCH",
      message: "The generated database client does not match this database.",
      hint: "Run `npx prisma generate` for the schema used by this deployment, then redeploy. A build cache from a SQLite schema produces this.",
      log: `Prisma datasource mismatch: ${raw.slice(0, 400)}`,
    };
  }

  if (
    /could not locate the query engine|query engine library for current platform|unable to require\(.*libquery_engine|binaryTargets/i.test(
      raw,
    )
  ) {
    return {
      status: 503,
      code: "PRISMA_ENGINE_MISSING",
      message: "The deployed database engine does not match this server platform.",
      hint: "The build generated a Prisma engine for a different OS. Add binaryTargets = [\"native\", \"rhel-openssl-3.0.x\"] to the generator block and redeploy.",
      log: `Prisma engine mismatch: ${raw}`,
    };
  }

  if (err instanceof Prisma.PrismaClientInitializationError) {
    return {
      status: 503,
      code: "DATABASE_UNAVAILABLE",
      message: "The server cannot reach its database.",
      hint: "Check DATABASE_URL (and DIRECT_URL) in the deployment environment. A Neon/Supabase project that is paused or a missing variable produces this.",
      log: `PrismaClientInitializationError: ${raw}`,
    };
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (PRISMA_BAD_CREDENTIALS.has(err.code)) {
      return {
        status: 503,
        code: "DATABASE_AUTH_FAILED",
        message: "The database rejected the server's credentials.",
        hint: `Prisma ${err.code}. The username or password in DATABASE_URL is wrong, or the role lacks access to this database.`,
        log: `Prisma ${err.code}: ${raw}`,
      };
    }
    if (PRISMA_NO_DATABASE.has(err.code)) {
      return {
        status: 503,
        code: "DATABASE_NOT_FOUND",
        message: "The database named in the connection URL does not exist.",
        hint: "Check the database name at the end of DATABASE_URL.",
        log: `Prisma ${err.code}: ${raw}`,
      };
    }
    if (PRISMA_UNREACHABLE.has(err.code)) {
      return {
        status: 503,
        code: "DATABASE_UNAVAILABLE",
        message: "The server cannot reach its database.",
        hint: `Prisma ${err.code}. Verify DATABASE_URL, that the database is running, and that this deployment's IP is allowed.`,
        log: `Prisma ${err.code}: ${raw}`,
      };
    }
    if (PRISMA_SCHEMA.has(err.code)) {
      return {
        status: 503,
        code: "DATABASE_SCHEMA_MISSING",
        message: "The database is connected but its tables are missing or out of date.",
        hint: "Run `npx prisma migrate deploy` against DATABASE_URL (DIRECT_URL for Neon), then reload.",
        log: `Prisma ${err.code}: ${raw}`,
      };
    }
    if (err.code === "P2002") {
      return {
        status: 409,
        code: "ALREADY_EXISTS",
        message: "That record already exists.",
        log: `Prisma P2002: ${raw}`,
      };
    }
    if (err.code === "P2025") {
      return {
        status: 404,
        code: "NOT_FOUND",
        message: "That record no longer exists.",
        log: `Prisma P2025: ${raw}`,
      };
    }
    return {
      status: 500,
      code: "DATABASE_ERROR",
      message: "The database rejected the request.",
      hint: `Prisma ${err.code}. Check the server logs for the full error.`,
      log: `Prisma ${err.code}: ${raw}`,
    };
  }

  if (err instanceof Prisma.PrismaClientValidationError) {
    return {
      status: 500,
      code: "DATABASE_QUERY_INVALID",
      message: "The server sent an invalid database query.",
      hint: "This is a code/schema mismatch — redeploy after `prisma generate`.",
      log: `PrismaClientValidationError: ${raw.slice(0, 800)}`,
    };
  }

  if (err instanceof Prisma.PrismaClientRustPanicError) {
    return {
      status: 500,
      code: "DATABASE_ENGINE_ERROR",
      message: "The database engine crashed while handling the request.",
      log: `PrismaClientRustPanicError: ${raw}`,
    };
  }

  return {
    status: 500,
    code: "INTERNAL",
    message: "Something went wrong. Please try again.",
    log: raw,
  };
}
