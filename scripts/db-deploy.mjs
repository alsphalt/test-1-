/**
 * Applies pending Prisma migrations to the database named by DATABASE_URL.
 *
 *   npm run db:deploy
 *
 * Safe to run repeatedly and safe to run from a build step: `prisma migrate
 * deploy` only applies migrations that are not yet recorded, never drops a
 * table, and never deletes rows.
 *
 * The one situation it repairs automatically is the one that produces
 * "connected but tables are missing or out of date" on a database that was
 * previously created with `prisma db push`: the tables exist but
 * `_prisma_migrations` is empty, so Prisma refuses to start (P3005). For each
 * such migration this script checks that *every* object the migration creates
 * already exists; only then does it record the migration as applied. If even
 * one object is missing it stops and reports what is missing instead of
 * guessing, because marking a half-applied migration as done would hide the
 * real gap.
 *
 * Environment:
 *   DATABASE_URL      required — pooled or direct Postgres URL
 *   DIRECT_URL        preferred — direct (non-pooled) URL used for DDL
 *   DB_MIGRATE_STRICT "false" downgrades a failure to a warning
 *   DB_MIGRATE_ALLOW_PREVIEW "true" lets a Vercel preview build migrate
 *
 * `--advisory` is used by the deploy build: if applying migrations fails but
 * the database already satisfies prisma/schema.prisma, the migration history is
 * merely out of step — the application can run, so the build continues with a
 * loud warning instead of blocking every subsequent deployment. If the schema
 * is genuinely behind, the build still fails.
 */
import { spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { listMigrations, migrationObjects } from "./lib/migration-objects.mjs";

const MIGRATIONS_DIR = "prisma/migrations";
const strict = (process.env.DB_MIGRATE_STRICT ?? "true").toLowerCase() !== "false";
const advisory = process.argv.includes("--advisory");

function say(line = "") {
  console.log(line);
}

function runPrisma(args) {
  const res = spawnSync("npx", ["prisma", ...args], {
    encoding: "utf8",
    env: { ...process.env, CHECKPOINT_DISABLE: "1" },
  });
  const out = `${res.stdout || ""}${res.stderr || ""}`.trim();
  return { status: res.status ?? 1, out };
}

function redact(text) {
  return text.replace(/postgres(ql)?:\/\/[^\s"']+/gi, "postgresql://[redacted]");
}

/**
 * Neon exposes a pooled endpoint (`ep-xxx-pooler.<region>.aws.neon.tech`) for
 * the app and the same database directly (`ep-xxx.<region>.aws.neon.tech`) for
 * DDL. PgBouncer cannot run the migration engine's statements, so a deployment
 * that only sets DATABASE_URL fails its build with a DDL error and never
 * deploys — which looks like "the site ignores my push".
 *
 * The direct hostname is the pooled one without the `-pooler` label; deriving
 * it is safe (same host, same credentials) and only used when DIRECT_URL is
 * genuinely unset.
 */
export function deriveNeonDirectUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (!parsed.hostname.endsWith(".neon.tech")) return "";
    if (!parsed.hostname.includes("-pooler.")) return "";
    parsed.hostname = parsed.hostname.replace("-pooler.", ".");
    // pgbouncer flags belong to the pooled connection only.
    parsed.searchParams.delete("pgbouncer");
    parsed.searchParams.delete("connection_limit");
    parsed.searchParams.delete("pool_timeout");
    return parsed.toString();
  } catch {
    return "";
  }
}

function fail(message, detail = "") {
  say(`\n\u2716 ${message}`);
  if (detail) say(redact(detail).split("\n").map((l) => `  ${l}`).join("\n"));
  say("\n  Nothing was dropped and no rows were deleted.");

  if (advisory) {
    // The migration bookkeeping is broken, but is the database itself usable?
    // Only prisma/schema.prisma can answer that, so ask the verifier.
    say("\n\u00b7 --advisory: checking whether the database already matches prisma/schema.prisma");
    const check = spawnSync(process.execPath, ["scripts/db-verify.mjs", "--quiet", "--gate"], {
      encoding: "utf8",
      env: { ...process.env, CHECKPOINT_DISABLE: "1" },
    });
    if (check.status === 0) {
      say("\u2713 the schema is complete — the application can run, continuing the build.");
      say("  This deploy did not change the database. Repair the migration history separately");
      say("  with: npm run db:verify  then  npm run db:deploy");
      process.exit(0);
    }
    say("\u2716 the schema is also incomplete — refusing to deploy code that needs missing objects.");
    const tail = `${check.stdout || ""}${check.stderr || ""}`.trim().split("\n").slice(-12).join("\n");
    if (tail) say(redact(tail).split("\n").map((l) => `  ${l}`).join("\n"));
  }

  process.exit(strict ? 1 : 0);
}

/* --------------------------------- catalog -------------------------------- */

async function catalog(prisma) {
  const tables = new Set(
    (await prisma.$queryRaw`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `).map((r) => r.table_name),
  );

  const columns = new Set(
    (await prisma.$queryRaw`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'
    `).map((r) => `${r.table_name}.${r.column_name}`),
  );

  const indexes = new Set(
    (await prisma.$queryRaw`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
    `).map((r) => r.indexname),
  );

  return { tables, columns, indexes };
}

async function appliedMigrations(prisma, hasMigrationsTable) {
  if (!hasMigrationsTable) return [];
  return prisma.$queryRaw`
    SELECT migration_name, finished_at, rolled_back_at, logs
    FROM _prisma_migrations
    ORDER BY started_at
  `;
}

/* -------------------------------- selftest -------------------------------- */

/**
 * `--selftest` proves the migration parser still understands the SQL Prisma
 * generates. It needs no database, so it can run in CI:
 *
 *   node scripts/db-deploy.mjs --selftest
 */
function selftest() {
  const expected = {
    "20260101000000_init": { tables: 9, columns: 0, indexes: 14 },
    "20260102000000_whatsapp": { tables: 3, columns: 0, indexes: 3 },
    "20260103000000_bot_sessions": { tables: 0, columns: 5, indexes: 2 },
    "20260104000000_bot_commands": { tables: 1, columns: 0, indexes: 1 },
    "20260201000000_setup_access": { tables: 4, columns: 0, indexes: 9 },
    "20260201000100_whatsapp_outbox": { tables: 1, columns: 0, indexes: 2 },
    // Data-only repair, no DDL: backfills placeholder externalIds.
    "20261127120000_whatsapp_pending_external_ids": { tables: 0, columns: 0, indexes: 0 },
  };

  const migrations = listMigrations(MIGRATIONS_DIR);
  const problems = [];

  // Direct-URL derivation: pooled Neon host → direct host, everything else untouched.
  const pooler = "postgresql://u:p@ep-cool-1234-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require&pgbouncer=true";
  const direct = "postgresql://u:p@ep-cool-1234.us-east-2.aws.neon.tech/neondb?sslmode=require";
  if (deriveNeonDirectUrl(pooler) !== direct) {
    problems.push(`deriveNeonDirectUrl(pooled) → ${deriveNeonDirectUrl(pooler) || "(empty)"}, expected ${direct}`);
  }
  if (deriveNeonDirectUrl(direct) !== "") problems.push("deriveNeonDirectUrl(direct) should return an empty string");
  if (deriveNeonDirectUrl("postgresql://u:p@db.example.com/app") !== "") {
    problems.push("deriveNeonDirectUrl(non-Neon) should return an empty string");
  }
  let tables = 0;
  let indexes = 0;

  for (const migration of migrations) {
    const objects = migrationObjects(migration.sql);
    const want = expected[migration.name];
    if (!want) {
      problems.push(`${migration.name}: no expectation recorded`);
      continue;
    }
    if (objects.tables.size !== want.tables) {
      problems.push(`${migration.name}: parsed ${objects.tables.size} table(s), expected ${want.tables}`);
    }
    if (objects.columns.length !== want.columns) {
      problems.push(`${migration.name}: parsed ${objects.columns.length} column(s), expected ${want.columns}`);
    }
    if (objects.indexes.length !== want.indexes) {
      problems.push(`${migration.name}: parsed ${objects.indexes.length} index(es), expected ${want.indexes}`);
    }
    tables += objects.tables.size;
    indexes += objects.indexes.length;
  }

  if (migrations.length !== Object.keys(expected).length) {
    problems.push(`found ${migrations.length} migration(s), expected ${Object.keys(expected).length}`);
  }
  if (tables !== 18) problems.push(`total tables ${tables}, expected 18`);
  if (indexes !== 31) problems.push(`total indexes ${indexes}, expected 31`);

  if (problems.length) {
    console.log("selftest FAIL");
    for (const p of problems) console.log(`  \u00b7 ${p}`);
    return 1;
  }
  console.log(`selftest PASS (${migrations.length} migrations, ${tables} tables, ${indexes} indexes)`);
  return 0;
}

if (process.argv.includes("--selftest")) {
  process.exit(selftest());
}

/* ---------------------------------- main ---------------------------------- */

if (!process.env.DATABASE_URL?.trim() && !process.env.DIRECT_URL?.trim()) {
  fail("DATABASE_URL is not set", "Set DATABASE_URL (and DIRECT_URL) for the scope you are deploying.");
}

if (!process.env.DIRECT_URL?.trim()) {
  const derived = deriveNeonDirectUrl(process.env.DATABASE_URL);
  if (derived) {
    process.env.DIRECT_URL = derived;
    say("· DIRECT_URL is not set — derived the Neon direct endpoint from DATABASE_URL.");
    say("  Set DIRECT_URL explicitly in Vercel to make this independent of the hostname.");
  } else {
    process.env.DIRECT_URL = process.env.DATABASE_URL;
    say("· DIRECT_URL is not set — falling back to DATABASE_URL for migrations.");
    say("  A pooled (PgBouncer) URL can reject DDL; if migration fails, set DIRECT_URL.");
  }
}

if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== "production" && process.env.DB_MIGRATE_ALLOW_PREVIEW !== "true") {
  say(`· VERCEL_ENV=${process.env.VERCEL_ENV} — skipping migrations (only production deploys migrate).`);
  say("  Set DB_MIGRATE_ALLOW_PREVIEW=true to migrate from a preview build.");
  process.exit(0);
}

const migrations = listMigrations(MIGRATIONS_DIR);
say(`Darknote schema deploy — ${migrations.length} migration(s) on disk`);

const prisma = new PrismaClient({ log: [] });

try {
  let state = await catalog(prisma);
  let hasHistory = state.tables.has("_prisma_migrations");
  let applied = await appliedMigrations(prisma, hasHistory);
  const appliedNames = new Set(applied.filter((r) => r.finished_at && !r.rolled_back_at).map((r) => r.migration_name));

  const pending = migrations.filter((m) => !appliedNames.has(m.name));
  if (pending.length === 0) {
    say("· nothing pending — the database already records every migration");
  } else {
    say(`· applying ${pending.length} pending migration(s)…`);
  }

  let result = pending.length === 0 ? { status: 0, out: "" } : runPrisma(["migrate", "deploy"]);
  if (result.out) say(redact(result.out).split("\n").map((l) => `  ${l}`).join("\n"));

  // Recovery path: the schema is non-empty but Prisma has no history for it.
  if (result.status !== 0) {
    // Only a schema/history conflict is worth repairing. A network, auth or
    // engine error must be reported as-is — "already exists" on its own also
    // matches unrelated driver messages such as "prepared statement s0".
    const blocked =
      /P3005|P3018|P3009|database schema is not empty|relation "[^"]+" already exists|table "[^"]+" already exists|type "[^"]+" already exists|migration `[^`]+` failed/i.test(
        result.out,
      );
    if (!blocked) fail("prisma migrate deploy failed", result.out);

    say("\n· the migration did not apply cleanly — checking which objects already exist");
    for (let attempt = 1; attempt <= migrations.length + 1; attempt++) {
      state = await catalog(prisma);
      hasHistory = state.tables.has("_prisma_migrations");
      applied = await appliedMigrations(prisma, hasHistory);
      const done = new Set(applied.filter((r) => r.finished_at && !r.rolled_back_at).map((r) => r.migration_name));
      let resolvedAny = false;

      for (const migration of migrations) {
        if (done.has(migration.name)) continue;
        const objects = migrationObjects(migration.sql);

        const missingTables = [...objects.tables.keys()].filter((t) => !state.tables.has(t));
        const missingColumns = objects.columns.filter((c) => !state.columns.has(`${c.table}.${c.column}`));
        const missingIndexes = objects.indexes.filter((i) => !state.indexes.has(i.name));

        if (missingTables.length || missingColumns.length || missingIndexes.length) {
          say(`  · ${migration.name} is not fully present — stopping here`);
          if (missingTables.length) say(`      missing table(s): ${missingTables.join(", ")}`);
          if (missingColumns.length) say(`      missing column(s): ${missingColumns.map((c) => `${c.table}.${c.column}`).join(", ")}`);
          if (missingIndexes.length) say(`      missing index(es): ${missingIndexes.map((i) => i.name).join(", ")}`);
          break;
        }

        const resolve = runPrisma(["migrate", "resolve", "--applied", migration.name]);
        if (resolve.status !== 0) fail(`could not baseline ${migration.name}`, resolve.out);
        say(`  ✓ ${migration.name} — every object exists; recorded as applied (no DDL run, no data touched)`);
        resolvedAny = true;
        break; // re-read history before the next migration
      }

      if (!resolvedAny) {
        const failedRow = applied.find((r) => !r.finished_at && !r.rolled_back_at);
        if (failedRow) {
          fail(
            `migration ${failedRow.migration_name} is in a failed state and is only partially applied`,
            `${failedRow.logs || ""}\n\nResolve it manually with one of:\n  npx prisma migrate resolve --rolled-back ${failedRow.migration_name}   (the migration did nothing)\n  npx prisma migrate resolve --applied ${failedRow.migration_name}        (it fully applied)`,
          );
        }
        fail("pending migrations could not be applied automatically", result.out);
      }

      result = runPrisma(["migrate", "deploy"]);
      if (result.out) say(redact(result.out).split("\n").map((l) => `  ${l}`).join("\n"));
      if (result.status === 0) break;
    }

    if (result.status !== 0) fail("prisma migrate deploy still fails", result.out);
  }

  state = await catalog(prisma);
  hasHistory = state.tables.has("_prisma_migrations");
  applied = await appliedMigrations(prisma, hasHistory);
  const finalApplied = applied.filter((r) => r.finished_at && !r.rolled_back_at);
  const stillPending = migrations.filter((m) => !finalApplied.some((r) => r.migration_name === m.name));

  say(`\n✓ ${finalApplied.length}/${migrations.length} migration(s) applied`);
  for (const row of finalApplied) say(`  · ${row.migration_name}`);
  if (stillPending.length) fail(`still pending: ${stillPending.map((m) => m.name).join(", ")}`);

  say("\nNext: npm run db:verify  (checks tables, columns, indexes and foreign keys)");
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
} finally {
  await prisma.$disconnect();
}
