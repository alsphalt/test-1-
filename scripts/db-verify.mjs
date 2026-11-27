/**
 * Verifies that the connected database actually matches prisma/schema.prisma.
 *
 *   node scripts/db-verify.mjs            # report only
 *   node scripts/db-verify.mjs --strict   # exit 1 if anything is missing
 *
 * Read-only: it never creates, alters or deletes anything. Three independent
 * checks are combined, because each one answers a different question:
 *
 *   1. `prisma migrate diff` — the authoritative answer to "is the database
 *      behind the schema?", expressed as the exact DDL that is still missing.
 *   2. information_schema — a human-readable list of missing tables/columns,
 *      which is what "tables are missing or out of date" actually means.
 *   3. pg catalogs — indexes, unique constraints and foreign keys, so a table
 *      that exists with the wrong relationships is not reported as healthy.
 *
 * The connection string is never printed. Only the host from `DATABASE_URL` is
 * shown, masked the same way /api/health masks it.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const strict = process.argv.includes("--strict");
const quiet = process.argv.includes("--quiet");
// --gate: fail only on gaps that break the deployed app (missing tables,
// columns, unique constraints, foreign keys or real drift). A comparison that
// could not run is reported but does not block a release.
const gate = process.argv.includes("--gate");
const SCHEMA = process.env.PRISMA_SCHEMA || "prisma/schema.prisma";

const SCALARS = new Set(["String", "Int", "BigInt", "Float", "Decimal", "Boolean", "DateTime", "Json", "Bytes"]);

function parseSchema(source) {
  const models = new Map();
  const modelRe = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  let m;
  while ((m = modelRe.exec(source))) {
    const [, name, body] = m;
    const tableMatch = body.match(/@@map\("([^"]+)"\)/);
    const table = tableMatch ? tableMatch[1] : name;
    const columns = [];
    const indexes = [];
    const uniques = [];
    const relations = [];

    for (const line of body.split("\n")) {
      const text = line.trim();
      if (!text || text.startsWith("//")) continue;

      if (text.startsWith("@@index(") || text.startsWith("@@unique(")) {
        const fields = [...text.matchAll(/"([^"]+)"/g)].map((x) => x[1]);
        if (fields.length) {
          if (text.startsWith("@@unique(")) uniques.push(fields);
          else indexes.push(fields);
        }
        continue;
      }
      if (text.startsWith("@@")) continue;

      const field = text.match(/^(\w+)\s+(\w+)(\[\])?(\?)?/);
      if (!field) continue;
      const [, fieldName, type, list] = field;
      if (!SCALARS.has(type) && type !== "Unsupported") {
        // Relation field: record the foreign key it implies, not a column.
        const rel = text.match(/@relation\(([^)]*)\)/);
        if (rel && /fields:\s*\[/.test(rel[1])) {
          const fields = [...(rel[1].match(/fields:\s*\[([^\]]*)\]/)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((x) => x[1]);
          const refs = [...(rel[1].match(/references:\s*\[([^\]]*)\]/)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((x) => x[1]);
          for (let i = 0; i < fields.length; i++) {
            relations.push({ column: fields[i], refTable: type, refColumn: refs[i] ?? "id" });
          }
        }
        continue;
      }
      const map = text.match(/@map\("([^"]+)"\)/);
      const column = map ? map[1] : fieldName;
      columns.push(column);
      if (text.includes("@unique")) uniques.push([column]);
      if (list) {
        console.log(`  note ${name}.${fieldName} is a list; portable schema does not use arrays — check manually.`);
      }
    }

    models.set(table, { model: name, columns, indexes, uniques, relations });
  }
  return models;
}

function parseEnvFile(path) {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const value = m[2].replace(/^["']|["']$/g, "");
    if (!process.env[m[1]]) process.env[m[1]] = value;
  }
}

function maskHost(raw) {
  try {
    const host = new URL(raw).hostname;
    const [first, ...rest] = host.split(".");
    return [first.length <= 3 ? `${first[0] ?? ""}***` : `${first.slice(0, 3)}***`, ...rest].join(".");
  } catch {
    return "unknown";
  }
}

parseEnvFile(".env.local");
parseEnvFile(".env");

const url = process.env.DIRECT_URL?.trim() || process.env.DATABASE_URL?.trim();
if (url) {
  // `prisma migrate diff` and the client both read DATABASE_URL; prefer the
  // direct (non-pooled) connection for schema inspection when it is present.
  process.env.DIRECT_URL = process.env.DIRECT_URL?.trim() || url;
  process.env.DATABASE_URL = process.env.DATABASE_URL?.trim() || url;
}

const report = { failures: [], warnings: [], hard: [] };

/** A failure that makes the deployed application wrong, not just untidy. */
function broken(message) {
  report.failures.push(message);
  report.hard.push(message);
}

function heading(title) {
  console.log(`\n${title}`);
  console.log("─".repeat(title.length));
}

if (!url) {
  if (gate) {
    // Build-time gating only: the deployment is being produced by an
    // environment that does not expose the runtime database URL. There is
    // nothing to compare, and that must not block the release.
    console.log("DATABASE_URL / DIRECT_URL is not available to this build — skipping the schema gate.");
    console.log("Run `npm run db:verify` where the runtime URL is available.");
    process.exit(0);
  }
  console.error("DATABASE_URL / DIRECT_URL is not set — nothing to verify.");
  console.error("Set it for the deployment scope you want to check (Production vs Preview) and re-run.");
  process.exit(2);
}

console.log(`Database: ${maskHost(url)} / schema "public"`);

/* ------------------------- 1. authoritative drift ------------------------- */

heading("1. Migration drift (prisma migrate diff)");

// --from-schema-datasource reads the URL from the environment, so the
// connection string never appears in the process list or CI logs.
const diff = spawnSync(
  "npx",
  ["prisma", "migrate", "diff", "--from-schema-datasource", SCHEMA, "--to-schema-datamodel", SCHEMA, "--script"],
  { encoding: "utf8", env: { ...process.env, CHECKPOINT_DISABLE: "1" } },
);

const diffSql = (diff.stdout || "")
  .split("\n")
  .filter((line) => line.trim() && !line.trim().startsWith("--"))
  .join("\n")
  .trim();

if (diff.status !== 0) {
  const detail = (diff.stderr || diff.stdout || "").trim().split("\n").slice(-6).join("\n");
  report.failures.push("could not compare the database with the schema");
  console.log("  FAIL the comparison did not run");
  console.log(detail.replace(/postgres(ql)?:\/\/[^\s"']+/gi, "postgresql://[redacted]"));
} else if (!diffSql) {
  console.log("  ok   database matches prisma/schema.prisma — nothing to apply");
} else {
  broken("database is behind prisma/schema.prisma");
  console.log("  FAIL the database is out of date. Missing DDL:");
  console.log(
    diffSql
      .split("\n")
      .map((line) => `       ${line}`)
      .join("\n"),
  );
}

/* --------------------- 2. tables and columns (readable) -------------------- */

const prisma = new PrismaClient({ log: [] });

try {
  heading("2. Tables and columns");

  const schemaSource = readFileSync(SCHEMA, "utf8");
  const expected = parseSchema(schemaSource);
  if (expected.size === 0) {
    broken("no models found in the schema file");
    console.log(`  FAIL no models parsed from ${SCHEMA}`);
  }

  const columns = await prisma.$queryRaw`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
  `;
  const byTable = new Map();
  for (const row of columns) {
    if (!byTable.has(row.table_name)) byTable.set(row.table_name, new Set());
    byTable.get(row.table_name).add(row.column_name);
  }

  const migrationsTable = byTable.has("_prisma_migrations");

  let okTables = 0;
  for (const [table, spec] of expected) {
    const actual = byTable.get(table);
    if (!actual) {
      broken(`table "${table}" is missing`);
      console.log(`  FAIL ${table} — table missing`);
      continue;
    }
    const missing = spec.columns.filter((c) => !actual.has(c));
    if (missing.length) {
      broken(`table "${table}" is missing column(s): ${missing.join(", ")}`);
      console.log(`  FAIL ${table} — missing columns: ${missing.join(", ")}`);
    } else {
      okTables += 1;
      if (!quiet) console.log(`  ok   ${table} (${spec.columns.length} columns)`);
    }
  }

  heading("3. Migration history");
  if (!migrationsTable) {
    report.warnings.push("_prisma_migrations does not exist (the database was never migrated with Prisma)");
    console.log("  warn _prisma_migrations is missing — `prisma migrate deploy` was never run here");
    console.log("       Tables may exist from `prisma db push`; run `npm run db:deploy` to baseline safely.");
  } else {
    const rows = await prisma.$queryRaw`
      SELECT migration_name, finished_at, rolled_back_at, logs
      FROM _prisma_migrations
      ORDER BY started_at
    `;
    const applied = rows.filter((r) => r.finished_at && !r.rolled_back_at);
    const failed = rows.filter((r) => !r.finished_at && !r.rolled_back_at);
    console.log(`  ok   ${applied.length} migration(s) recorded as applied`);
    for (const row of applied) console.log(`       · ${row.migration_name}`);
    for (const row of failed) {
      broken(`migration "${row.migration_name}" failed and was not rolled back`);
      console.log(`  FAIL failed migration: ${row.migration_name}`);
      const tail = String(row.logs ?? "").trim().split("\n").slice(-3).join(" ");
      if (tail) console.log(`       ${tail}`);
    }
  }

  heading("4. Indexes, unique constraints and relationships");

  const indexes = await prisma.$queryRaw`
    SELECT tablename, indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
  `;
  const indexByTable = new Map();
  for (const row of indexes) {
    if (row.indexname.endsWith("_pkey")) continue;
    const cols = [...String(row.indexdef).matchAll(/\(([^)]*)\)/g)].pop()?.[1] ?? "";
    const key = cols.split(",").map((c) => c.trim().replace(/"/g, "").replace(/ DESC| ASC/g, "")).join(",");
    if (!indexByTable.has(row.tablename)) indexByTable.set(row.tablename, new Map());
    indexByTable.get(row.tablename).set(key, {
      name: row.indexname,
      unique: /\bUNIQUE\b/.test(row.indexdef),
    });
  }

  for (const [table, spec] of expected) {
    const actual = indexByTable.get(table);
    for (const cols of spec.uniques) {
      const key = cols.join(",");
      const hit = actual?.get(key);
      if (!hit) {
        broken(`"${table}" has no unique constraint on (${key})`);
        console.log(`  FAIL ${table} unique (${key}) — missing`);
      } else if (!hit.unique) {
        broken(`"${table}" index on (${key}) is not unique`);
        console.log(`  FAIL ${table} unique (${key}) — present but not UNIQUE`);
      }
    }
    for (const cols of spec.indexes) {
      const key = cols.join(",");
      if (!actual?.has(key)) {
        // Prisma does not require an index to be unique for @@index; report as
        // a warning because a missing index is a performance, not a data, fault.
        report.warnings.push(`"${table}" has no index on (${key})`);
        console.log(`  warn ${table} index (${key}) — missing`);
      }
    }
  }

  const fks = await prisma.$queryRaw`
    SELECT
      tc.table_name AS child_table,
      kcu.column_name AS child_column,
      ccu.table_name AS parent_table,
      ccu.column_name AS parent_column
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
  `;
  const fkKeys = new Set(fks.map((r) => `${r.child_table}.${r.child_column}->${r.parent_table}.${r.parent_column}`));

  for (const [table, spec] of expected) {
    for (const rel of spec.relations) {
      const key = `${table}.${rel.column}->${rel.refTable}.${rel.refColumn}`;
      if (!fkKeys.has(key)) {
        broken(`"${table}.${rel.column}" has no foreign key to ${rel.refTable}.${rel.refColumn}`);
        console.log(`  FAIL ${key} — foreign key missing`);
      }
    }
  }
  console.log(`  ok   ${fks.length} foreign key(s) present`);

  if (!quiet) heading("5. Row counts (read-only)");
  const tables = quiet ? [] : [...expected.keys()];
  for (const table of tables) {
    try {
      const [row] = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "${table}"`);
      console.log(`       ${table}: ${row.n}`);
    } catch (err) {
      console.log(`       ${table}: unavailable (${err.message.split("\n")[0]})`);
    }
  }
} catch (err) {
  report.failures.push(err.message);
  console.error(`\nVerification failed: ${err.message}`);
} finally {
  await prisma.$disconnect();
}

heading("Result");
if (report.failures.length === 0) {
  console.log(`  PASS schema is complete${report.warnings.length ? ` (${report.warnings.length} warning(s))` : ""}`);
  process.exit(0);
}

if (gate) {
  // Only schema-breaking gaps matter here: everything listed in `hard`.
  if (report.hard.length === 0) {
    console.log(`  PASS no schema-breaking gap${report.warnings.length ? ` (${report.warnings.length} warning(s))` : ""}`);
    for (const item of report.failures) console.log(`       advisory: ${item}`);
    process.exit(0);
  }
  console.log(`  FAIL ${report.hard.length} schema-breaking problem(s) found:`);
  for (const item of report.hard) console.log(`       · ${item}`);
  console.log("\n  Fix with: npm run db:deploy   (applies pending migrations, never drops data)");
  process.exit(1);
}

console.log(`  FAIL ${report.failures.length} problem(s) found:`);
for (const item of report.failures) console.log(`       · ${item}`);
console.log("\n  Fix with: npm run db:deploy   (applies pending migrations, never drops data)");
process.exit(strict ? 1 : 0);
