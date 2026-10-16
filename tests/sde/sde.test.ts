import { describe, expect, it, beforeAll } from "vitest";
import path from "node:path";
import Database from "better-sqlite3";
import { createSdeSchema, insertBlueprints, insertGroups, insertSystems, insertTypes, sanityCheck } from "@/sde/build";
import { parseBlueprintRecord, parseGroupRecord, parseSystemRecord, parseTypeRecord } from "@/sde/parse";
import { SqliteSdeSource } from "@/sde/sqliteSource";
import { FixtureSdeSource } from "@/sde/fixtureSource";
import { findEntry, listZipEntries, readJsonlEntry, type JsonRecord } from "@/sde/zipJsonl";
import type { SdeGroup, SdeSource, SdeSystem, SdeType } from "@/sde/types";
import type { Blueprint } from "@/engine/types";

// SYNTHETIC mini SDE in the official JSONL shape (tests/data/mini-sde.zip).
const ZIP = path.resolve(__dirname, "../data/mini-sde.zip");

async function readAll(entry: string): Promise<JsonRecord[]> {
  const out: JsonRecord[] = [];
  await readJsonlEntry(ZIP, entry, (r) => out.push(r));
  return out;
}

let groups: SdeGroup[];
let types: SdeType[];
let bps: Blueprint[];
let systems: SdeSystem[];
let skipped = { groups: 0, types: 0, bps: 0 };

beforeAll(async () => {
  const entries = await listZipEntries(ZIP);
  const g = await readAll(findEntry(entries, "groups.jsonl")!);
  const t = await readAll(findEntry(entries, "types.jsonl")!);
  const b = await readAll(findEntry(entries, "blueprints.jsonl")!);
  systems = (await readAll(findEntry(entries, "mapSolarSystems.jsonl")!)).map(parseSystemRecord).filter((x): x is SdeSystem => x !== null);
  groups = g.map(parseGroupRecord).filter((x): x is SdeGroup => x !== null);
  const gc = new Map(groups.map((x) => [x.groupId, x.categoryId]));
  types = t.map((r) => parseTypeRecord(r, gc)).filter((x): x is SdeType => x !== null);
  bps = b.map(parseBlueprintRecord).filter((x): x is Blueprint => x !== null);
  skipped = { groups: g.length - groups.length, types: t.length - types.length, bps: b.length - bps.length };
});

describe("zip + JSONL parsing", () => {
  it("finds nested entries", async () => {
    const entries = await listZipEntries(ZIP);
    expect(findEntry(entries, "types.jsonl")).toBe("sde/types.jsonl");
    expect(findEntry(entries, "nope.jsonl")).toBeUndefined();
  });

  it("parses good records and skips broken ones", () => {
    expect(types.map((t) => t.name)).toContain("Tritanium");
    expect(skipped).toEqual({ groups: 1, types: 1, bps: 1 });
  });

  it("links category through group", () => {
    expect(types.find((t) => t.typeId === 34)?.categoryId).toBe(4);
  });

  it("parses activities, ignores unknown ones, keeps invention probability", () => {
    const ram = bps.find((b) => b.blueprintTypeId === 11479)!;
    expect(Object.keys(ram.activities).sort()).toEqual(["copying", "invention", "manufacturing"]);
    expect(ram.activities.manufacturing?.products[0]).toEqual({ typeId: 11478, quantity: 100 });
    expect(ram.activities.invention?.products[0].probability).toBe(0.34);
    expect(ram.activities.copying?.materials).toEqual([]);
  });
});

describe("SdeSource implementations agree", () => {
  let sqlite: SdeSource;
  let fixture: SdeSource;

  beforeAll(() => {
    const db = new Database(":memory:");
    createSdeSchema(db);
    insertGroups(db, groups);
    insertTypes(db, types);
    insertBlueprints(db, bps);
    insertSystems(db, systems);
    sqlite = new SqliteSdeSource(db);
    fixture = new FixtureSdeSource({
      meta: { source: "test", capturedAt: "", roots: [] },
      types,
      blueprints: bps,
      systems,
    });
  });

  it.each(["sqlite", "fixture"])("%s: systems", (name) => {
    const src = name === "sqlite" ? sqlite : fixture;
    expect(src.getSystem(30000142)).toEqual({ systemId: 30000142, name: "Jita", security: 0.9459 });
    expect(src.searchSystems("peri").map((s) => s.name)).toEqual(["Perimeter"]);
  });

  it.each(["sqlite", "fixture"])("%s: searchBuildable returns only producible types", (name) => {
    const src = name === "sqlite" ? sqlite : fixture;
    expect(src.searchBuildable("r").map((t) => t.typeId)).toEqual([11478]);
  });

  it.each(["sqlite", "fixture"])("%s: getType", (name) => {
    const src = name === "sqlite" ? sqlite : fixture;
    expect(src.getType(11478)?.name).toBe("R.A.M.- Starship Tech");
    expect(src.getType(424242)).toBeUndefined();
  });

  it("same blueprint from both", () => {
    expect(sqlite.getBlueprint(11479)).toEqual(fixture.getBlueprint(11479));
  });

  it.each(["sqlite", "fixture"])("%s: findProducers", (name) => {
    const src = name === "sqlite" ? sqlite : fixture;
    expect(src.findProducers(11478)).toEqual([{ blueprintTypeId: 11479, activity: "manufacturing" }]);
    expect(src.findProducers(11478, "reaction")).toEqual([]);
  });

  it.each(["sqlite", "fixture"])("%s: searchTypes", (name) => {
    const src = name === "sqlite" ? sqlite : fixture;
    expect(src.searchTypes("starship").map((t) => t.typeId)).toContain(11478);
  });
});

describe("sanityCheck", () => {
  it("flags a too-small import (catches silent schema changes)", () => {
    const db = new Database(":memory:");
    createSdeSchema(db);
    insertGroups(db, groups);
    insertTypes(db, types);
    insertBlueprints(db, bps);
    const r = sanityCheck(db);
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toMatch(/too few types/);
  });
});

describe("consumeJsonl", () => {
  it("handles lines split across chunks and multibyte chars split mid-character", async () => {
    const { Readable } = await import("node:stream");
    const { consumeJsonl } = await import("@/sde/zipJsonl");
    const text = '{"a":"Тритан"}\n{"a":2}\n\n{"a":3}';
    const bytes = Buffer.from(text, "utf8");
    const chunks = [bytes.subarray(0, 9), bytes.subarray(9, 20), bytes.subarray(20)]; // byte 9 splits "р"
    const got: unknown[] = [];
    const n = await consumeJsonl(Readable.from(chunks), (r) => got.push(r.a));
    expect(n).toBe(3);
    expect(got).toEqual(["Тритан", 2, 3]);
  });

  it("rejects (does not hang) on a broken line", async () => {
    const { Readable } = await import("node:stream");
    const { consumeJsonl } = await import("@/sde/zipJsonl");
    await expect(consumeJsonl(Readable.from([Buffer.from('{"a":1}\n{oops\n')]), () => {})).rejects.toThrow(/line 2/);
  });

  it("rejects (does not hang) on a stream error", async () => {
    const { Readable } = await import("node:stream");
    const { consumeJsonl } = await import("@/sde/zipJsonl");
    const s = new Readable({ read() { this.destroy(new Error("invalid stored block lengths")); } });
    await expect(consumeJsonl(s, () => {})).rejects.toThrow(/invalid stored/);
  });
});
