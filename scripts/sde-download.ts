/**
 * LOCAL ONLY — needs internet access to developers.eveonline.com.
 *
 *   npm run sde:download            # download latest SDE (if newer) and build data/sde.sqlite
 *   npm run sde:download -- --force # rebuild even if the build number did not change
 *
 * Source: official CCP SDE, JSON Lines flavour.
 * Docs:   https://developers.eveonline.com/docs/services/static-data/
 */
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import Database from "better-sqlite3";
import { createSdeSchema, insertBlueprints, insertGroups, insertTypes, sanityCheck, setMeta } from "../src/sde/build";
import { parseBlueprintRecord, parseGroupRecord, parseTypeRecord } from "../src/sde/parse";
import type { SdeGroup, SdeType } from "../src/sde/types";
import type { Blueprint } from "../src/engine/types";
import { findEntry, listZipEntries, readJsonlEntry } from "../src/sde/zipJsonl";

const LATEST_INFO = "https://developers.eveonline.com/static-data/tranquility/latest.jsonl";
const ZIP_URL = "https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip";
const DATA_DIR = path.resolve("data");
const DB_PATH = path.join(DATA_DIR, "sde.sqlite");
const USER_AGENT = "production-giant (personal EVE industry tool; github.com/sedrionn/production_giant)";

async function latestBuild(): Promise<string> {
  const res = await fetch(LATEST_INFO, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`latest.jsonl: HTTP ${res.status}`);
  const text = await res.text();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line) as Record<string, unknown>;
    if (rec._key === "sde") {
      const build = rec.buildNumber ?? rec.build ?? rec.version;
      if (build !== undefined) return String(build);
      console.warn("Unknown 'sde' record shape, using whole record as version:", rec);
      return JSON.stringify(rec);
    }
  }
  throw new Error(`no record with _key "sde" in latest.jsonl:\n${text.slice(0, 500)}`);
}

function currentBuild(): string | undefined {
  if (!fs.existsSync(DB_PATH)) return undefined;
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const r = db.prepare("SELECT value FROM sde_meta WHERE key = 'build'").get() as { value: string } | undefined;
    return r?.value;
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  let done = 0;
  let lastPct = -1;
  const body = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
  body.on("data", (chunk: Buffer) => {
    done += chunk.length;
    const pct = total ? Math.floor((done / total) * 100) : -1;
    if (pct !== lastPct && pct % 10 === 0) {
      lastPct = pct;
      process.stdout.write(` ${pct}%`);
    }
  });
  await pipeline(body, fs.createWriteStream(dest));
  process.stdout.write("\n");
}

async function main() {
  const force = process.argv.includes("--force");
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const build = await latestBuild();
  const have = currentBuild();
  console.log(`latest SDE build: ${build}; local: ${have ?? "none"}`);
  if (have === build && !force) {
    console.log("Up to date. Use --force to rebuild.");
    return;
  }

  const zipPath = path.join(DATA_DIR, `sde-${build.replace(/[^\w.-]/g, "_")}.zip`);
  if (!fs.existsSync(zipPath)) {
    console.log(`downloading ${ZIP_URL}`);
    await download(ZIP_URL, zipPath + ".part");
    fs.renameSync(zipPath + ".part", zipPath);
  }

  const entries = await listZipEntries(zipPath);
  const need = ["groups.jsonl", "types.jsonl", "blueprints.jsonl"];
  const resolved = Object.fromEntries(need.map((n) => [n, findEntry(entries, n)]));
  const missing = need.filter((n) => !resolved[n]);
  if (missing.length) {
    console.error(`Missing ${missing.join(", ")} in zip. Entries:\n  ${entries.slice(0, 80).join("\n  ")}`);
    process.exit(1);
  }

  const tmp = DB_PATH + ".tmp";
  fs.rmSync(tmp, { force: true });
  const db = new Database(tmp);
  db.pragma("journal_mode = OFF");
  db.pragma("synchronous = OFF");
  createSdeSchema(db);

  const skipped: Record<string, number> = { groups: 0, types: 0, blueprints: 0 };
  const firstSkipped: Record<string, unknown> = {};
  const skip = (kind: string, r: unknown) => {
    skipped[kind]++;
    firstSkipped[kind] ??= r;
  };

  const groups: SdeGroup[] = [];
  await readJsonlEntry(zipPath, resolved["groups.jsonl"]!, (r) => {
    const g = parseGroupRecord(r);
    if (g) groups.push(g);
    else skip("groups", r);
  });
  insertGroups(db, groups);
  const groupCategory = new Map(groups.map((g) => [g.groupId, g.categoryId]));

  const types: SdeType[] = [];
  await readJsonlEntry(zipPath, resolved["types.jsonl"]!, (r) => {
    const t = parseTypeRecord(r, groupCategory);
    if (t) types.push(t);
    else skip("types", r);
  });
  insertTypes(db, types);

  const bps: Blueprint[] = [];
  await readJsonlEntry(zipPath, resolved["blueprints.jsonl"]!, (r) => {
    const b = parseBlueprintRecord(r);
    if (b) bps.push(b);
    else skip("blueprints", r);
  });
  insertBlueprints(db, bps);

  setMeta(db, { build, source: ZIP_URL, importedAt: new Date().toISOString() });
  const report = sanityCheck(db);
  db.close();

  console.log("counts:", report.counts);
  console.log("skipped records:", skipped);
  for (const [k, v] of Object.entries(firstSkipped)) {
    console.log(`first skipped ${k} record:`, JSON.stringify(v).slice(0, 400));
  }
  if (!report.ok) {
    console.error("SANITY CHECK FAILED:\n  " + report.problems.join("\n  "));
    console.error(`Left the broken DB at ${tmp} for inspection; data/sde.sqlite was NOT replaced.`);
    process.exit(1);
  }
  fs.renameSync(tmp, DB_PATH);
  console.log(`OK → ${DB_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
