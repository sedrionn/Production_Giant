/** Server-side only. Opens data/app.sqlite, applies migrations, seeds defaults. */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";
import { seedDefaults } from "./seed";

export type AppDb = BetterSQLite3Database<typeof schema>;

export function openAppDb(file = path.resolve("data/app.sqlite")): AppDb {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: path.resolve("drizzle") });
  seedDefaults(db);
  return db;
}
