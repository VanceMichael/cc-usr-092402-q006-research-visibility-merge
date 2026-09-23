import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "migrations");

export function openDatabase(file = process.env.LEDGER_DB || "data/app.db") {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

export function migrate(db) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
  );
  const applied = new Set(
    db.prepare("SELECT version FROM schema_version").all().map((r) => r.version)
  );
  const files = readdirSync(migrationsDir)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort();
  for (const f of files) {
    const version = Number(f.slice(0, 3));
    if (applied.has(version)) continue;
    const sql = readFileSync(join(migrationsDir, f), "utf8");
    const tx = db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT OR IGNORE INTO schema_version(version) VALUES (?)").run(version);
    });
    tx();
  }
}
