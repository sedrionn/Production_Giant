/** Loads the committed REAL data snapshot (fixtures/) for tests. */
import fs from "node:fs";
import path from "node:path";
import { FixtureSdeSource } from "@/sde/fixtureSource";
import type { SdeSubset } from "@/sde/types";
import type { MarketQuote } from "@/engine/pricing";
import type { CostIndices } from "@/esi/transform";

const root = path.resolve(__dirname, "../../fixtures");
const read = <T>(p: string): T => JSON.parse(fs.readFileSync(path.join(root, p), "utf8")) as T;

export function loadFixtures() {
  const subset = read<SdeSubset>("sde/subset.json");
  const adjusted = read<{ prices: Record<string, number> }>("esi/adjusted-prices.json").prices;
  const indices = read<{ systems: Record<string, CostIndices> }>("esi/cost-indices.json").systems;
  const quotes = read<{ quotes: Record<string, MarketQuote> }>("esi/jita-quotes.json").quotes;
  return {
    subset,
    sde: new FixtureSdeSource(subset),
    adjustedPrice: (id: number) => adjusted[id],
    costIndices: (systemId: number) => indices[systemId] ?? {},
    quote: (id: number) => quotes[id],
  };
}
