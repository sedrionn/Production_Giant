/**
 * LOCAL ONLY — needs data/sde.sqlite (npm run sde:download) and internet access to ESI.
 *
 *   npm run fixtures:capture
 *   npm run fixtures:capture -- "Jackdaw" "Hammerhead II" 34828
 *
 * Cuts a small, committed snapshot of real data so cloud sessions and tests can
 * work without network access:
 *   fixtures/sde/subset.json          full production trees of the root items
 *   fixtures/esi/adjusted-prices.json adjusted prices for those types
 *   fixtures/esi/cost-indices.json    cost indices for a few systems
 *   fixtures/esi/jita-quotes.json     best bid/ask at Jita 4-4 for every marketable type in the trees
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { SqliteSdeSource } from "../src/sde/sqliteSource";
import { collectTree } from "../src/sde/collect";
import type { SdeGroup, SdeSubset, SdeSystem, SdeType } from "../src/sde/types";
import type { Blueprint } from "../src/engine/types";
import { getIndustrySystems, getMarketPrices, getRegionOrders, mapLimit } from "../src/esi/client";
import { adjustedPriceMap, aggregateOrders, costIndicesBySystem } from "../src/esi/transform";
import { REGION_THE_FORGE, STATION_JITA_4_4, SYSTEM_JITA } from "../src/esi/types";

/** One item per interesting production path. Override from the command line. */
const DEFAULT_ROOTS: (string | number)[] = [
  34828, // Jackdaw — T3 destroyer, the old-sheet golden case
  "R.A.M.- Starship Tech", // portion size 100
  "Hammerhead II", // T2 drone, invention
  "Capital Armor Plates", // capital component
  "Fullerene Intercalated Graphite", // polymer reaction
  "Flycatcher", // T2 Caldari, EVE Guru reference
  "Golem", // T2 battleship, EVE Guru reference
  "Medium Core Defense Field Extender II", // T2 rig, EVE Guru reference
];
const EXTRA_SYSTEMS = [30000144]; // Perimeter — add your Sotiyo system here

const SDE_PATH = path.resolve("data/sde.sqlite");
const OUT_SDE = path.resolve("fixtures/sde");
const OUT_ESI = path.resolve("fixtures/esi");

function write(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 1) + "\n");
  console.log(`wrote ${path.relative(process.cwd(), file)} (${(fs.statSync(file).size / 1024).toFixed(1)} KB)`);
}

async function main() {
  if (!fs.existsSync(SDE_PATH)) {
    console.error("data/sde.sqlite not found — run `npm run sde:download` first.");
    process.exit(1);
  }
  const db = new Database(SDE_PATH, { readonly: true });
  const sde = new SqliteSdeSource(db);
  const build = (db.prepare("SELECT value FROM sde_meta WHERE key='build'").get() as { value: string } | undefined)?.value;

  const args = process.argv.slice(2);
  const rootsInput = args.length ? args.map((a) => (/^\d+$/.test(a) ? Number(a) : a)) : DEFAULT_ROOTS;
  const roots: number[] = [];
  for (const r of rootsInput) {
    if (typeof r === "number") roots.push(r);
    else {
      const exact = sde.searchTypes(r, 50).find((t) => t.name.toLowerCase() === r.toLowerCase());
      if (!exact) {
        console.warn(`! root "${r}" not found by exact name — skipped`);
        continue;
      }
      roots.push(exact.typeId);
    }
  }
  console.log("roots:", roots.map((id) => `${id} ${sde.getType(id)?.name}`).join(", "));

  const tree = collectTree(sde, roots);
  const types = [...tree.typeIds].map((id) => sde.getType(id)).filter((t): t is SdeType => !!t);
  const blueprints = [...tree.blueprintIds].map((id) => sde.getBlueprint(id)).filter((b): b is Blueprint => !!b);
  const subset: SdeSubset = {
    meta: { source: "CCP SDE (JSONL) via data/sde.sqlite", build, capturedAt: new Date().toISOString(), roots },
    types: types.sort((a, b) => a.typeId - b.typeId),
    blueprints: blueprints.sort((a, b) => a.blueprintTypeId - b.blueprintTypeId),
    systems: [SYSTEM_JITA, ...EXTRA_SYSTEMS].map((id) => sde.getSystem(id)).filter((x): x is SdeSystem => !!x),
    groups: [...new Set(types.map((t) => t.groupId))].map((id) => sde.getGroup(id)).filter((g): g is SdeGroup => !!g),
    decryptors: sde.listDecryptors(),
  };
  write(path.join(OUT_SDE, "subset.json"), subset);
  console.log(`  ${types.length} types, ${blueprints.length} blueprints, ${tree.leafTypeIds.size} raw leaves`);

  console.log("ESI: /markets/prices …");
  const adj = adjustedPriceMap(await getMarketPrices());
  write(path.join(OUT_ESI, "adjusted-prices.json"), {
    capturedAt: new Date().toISOString(),
    prices: Object.fromEntries([...tree.typeIds].filter((id) => adj.has(id)).map((id) => [id, adj.get(id)])),
  });

  console.log("ESI: /industry/systems …");
  const ci = costIndicesBySystem(await getIndustrySystems());
  write(path.join(OUT_ESI, "cost-indices.json"), {
    capturedAt: new Date().toISOString(),
    systems: Object.fromEntries([SYSTEM_JITA, ...EXTRA_SYSTEMS].map((s) => [s, ci.get(s) ?? {}])),
  });

  const marketable = [
    ...types.filter((t) => t.published && t.marketGroupId !== null).map((t) => t.typeId),
    ...subset.decryptors!.map((d) => d.typeId),
  ];
  console.log(`ESI: Jita orders for ${marketable.length} types …`);
  const quotes = await mapLimit(marketable, 6, async (typeId, i) => {
    const orders = await getRegionOrders(REGION_THE_FORGE, typeId);
    if ((i + 1) % 20 === 0) console.log(`  ${i + 1}/${marketable.length}`);
    return aggregateOrders(typeId, orders, STATION_JITA_4_4);
  });
  write(path.join(OUT_ESI, "jita-quotes.json"), {
    capturedAt: new Date().toISOString(),
    locationId: STATION_JITA_4_4,
    quotes: Object.fromEntries(quotes.map((q) => [q.typeId, q])),
  });

  db.close();
  console.log("\nDone. Commit fixtures/ and push.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
