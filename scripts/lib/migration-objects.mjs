/**
 * Reads the generated Prisma migration files and reports the objects each one
 * creates. Used by scripts/db-deploy.mjs to decide whether an unrecorded
 * migration is already reflected in the database.
 *
 * Prisma's generated SQL is uniform, so a statement-level parse is enough. It
 * is deliberately conservative: anything it cannot classify is ignored, which
 * only ever makes the deploy script ask for a human decision.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function listMigrations(dir = "prisma/migrations") {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .filter((name) => existsSync(join(dir, name, "migration.sql")))
    .map((name) => ({
      name,
      sql: readFileSync(join(dir, name, "migration.sql"), "utf8"),
    }));
}

export function migrationObjects(sql) {
  const clean = sql.replace(/--[^\n]*/g, "");
  const tables = new Map();
  const columns = [];
  const indexes = [];

  for (const raw of clean.split(";")) {
    const stmt = raw.trim();
    if (!stmt) continue;

    const createTable = stmt.match(/^CREATE TABLE\s+"([^"]+)"/i);
    if (createTable) {
      const body = stmt.slice(stmt.indexOf("(") + 1, stmt.lastIndexOf(")"));
      const cols = new Set();
      for (const line of body.split("\n")) {
        const col = line.trim().match(/^"([^"]+)"/);
        if (col) cols.add(col[1]);
      }
      tables.set(createTable[1], cols);
      continue;
    }

    const createIndex = stmt.match(/^CREATE\s+(?:UNIQUE\s+)?INDEX\s+"([^"]+)"\s+ON\s+"([^"]+)"/i);
    if (createIndex) {
      indexes.push({ name: createIndex[1], table: createIndex[2] });
      continue;
    }

    const alter = stmt.match(/^ALTER TABLE\s+"([^"]+)"/i);
    if (alter) {
      for (const m of stmt.matchAll(/ADD COLUMN\s+"([^"]+)"/gi)) {
        columns.push({ table: alter[1], column: m[1] });
      }
    }
  }

  return { tables, columns, indexes };
}
