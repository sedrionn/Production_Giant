/**
 * Profitability overview: one full-tree calculation per item of a category,
 * with the batch sized so the product's job runs ~targetJobDays.
 */
import { calculate, priceTypesFor, type CalcRequest } from "./calculate";
import { categoryHint, listCategory, type CategoryKey } from "./catalog";
import { hasCharacters, ownedBlueprintIndex } from "./characters";
import { depthFor, getSde, getSettings, volumesFor } from "./data";

/** When a batch looks hard to sell. UX thresholds, not game constants. */
export const MARKET_RISK = {
  /** Batch bigger than this many days of average sales. */
  maxMarketDays: 7,
  /** More than this share of sell orders repriced in the last 24 h = a price war. */
  maxFreshShare: 0.5,
  /** 7-day average price this much below the 30-day one = falling. */
  minPriceTrend: -0.1,
} as const;

export function marketRisks(r: { marketDays: number | null; sellOrders: number | null; sellOrdersFresh: number | null; priceTrend: number | null }): string[] {
  const out: string[] = [];
  if (r.marketDays !== null && r.marketDays > MARKET_RISK.maxMarketDays) out.push(`партия = ${r.marketDays.toFixed(0)} дней продаж`);
  if (r.sellOrders && r.sellOrdersFresh !== null && r.sellOrdersFresh / r.sellOrders > MARKET_RISK.maxFreshShare && r.sellOrders >= 4) {
    out.push(`цену перебивают: ${r.sellOrdersFresh} из ${r.sellOrders} ордеров обновлены за сутки`);
  }
  if (r.priceTrend !== null && r.priceTrend < MARKET_RISK.minPriceTrend) out.push(`цена падает: ${(r.priceTrend * 100).toFixed(0)}% за неделю`);
  return out;
}

export interface OverviewRow {
  typeId: number;
  name: string;
  group: string;
  /** bpo / bpc (owned), invention, none (no blueprint, ME/TE from settings), null on error. */
  blueprintSource: "bpo" | "bpc" | "invention" | "none" | null;
  runs: number;
  /** Most runs one batch can have (BPC runs, invented runs or blueprint limit); 0 = no limit. */
  maxRuns: number;
  output: number;
  profit: number | null;
  profitPerRun: number | null;
  margin: number | null;
  totalCost: number;
  /** Profit per hour of the product's own job (slot time). */
  iskPerHour: number | null;
  /** Product job duration for the batch, seconds. */
  jobSeconds: number;
  unitPrice: number | null;
  avgDailyVolume7d: number | null;
  avgDailyVolume30d: number | null;
  /** How many days of average market volume the batch represents. */
  marketDays: number | null;
  /** Sell orders at the hub and how many were repriced in the last 24 h. */
  sellOrders: number | null;
  sellOrdersFresh: number | null;
  /** 7-day average price vs 30-day, as a fraction (−0.12 = 12% lower). */
  priceTrend: number | null;
  /** Human-readable reasons the batch may be hard to sell; empty = fine. */
  marketRisks: string[];
  warnings: number;
  error: string | null;
}

export interface Overview {
  category: CategoryKey;
  hint: string | null;
  rows: OverviewRow[];
  targetJobDays: number;
  pricesOldest: string | null;
  computedMs: number;
}

export function itemsOf(category: CategoryKey) {
  const owned = category === "mine" ? [...ownedBlueprintIndex().keys()] : [];
  return listCategory(getSde().source, category, owned);
}

/** Runs needed for the product job to last ~days, capped by the blueprint's max runs. */
export function batchRuns(secondsPerRun: number, days: number, maxRuns: number): number {
  if (secondsPerRun <= 0) return 1;
  const runs = Math.max(1, Math.floor((days * 86400) / secondsPerRun));
  return maxRuns > 0 ? Math.min(runs, maxRuns) : runs;
}

export function computeOverview(category: CategoryKey, extra: Partial<CalcRequest> = {}): Overview {
  const t0 = Date.now();
  const { source: sde } = getSde();
  const s = getSettings();
  const items = itemsOf(category);
  const volumes = volumesFor(items.map((i) => i.typeId), s.priceRegionId);
  const depth = depthFor(items.map((i) => i.typeId), s.priceLocationId);
  let oldest: string | null = null;

  const rows: OverviewRow[] = items.map((item) => {
    const group = sde.getGroup(item.groupId)?.name ?? "";
    try {
      // Pass 1: one run to learn the product's job time and blueprint limit.
      const probe = calculate({ ...extra, typeId: item.typeId, runs: 1 });
      const rootJob = probe.jobs.at(-1)!;
      const bp = sde.getBlueprint(rootJob.blueprintTypeId);
      const invented = probe.request.blueprintSource === "invention" ? probe.invention.chosen?.runsPerSuccess ?? 0 : 0;
      const ownedBpc = probe.request.blueprintSource === "owned" && probe.ownedBlueprint && !probe.ownedBlueprint.isBpo ? probe.ownedBlueprint.runs : 0;
      const maxRuns = invented || ownedBpc || bp?.maxProductionLimit || 0;
      const runs = batchRuns(rootJob.timeSeconds, s.targetJobDays, maxRuns);
      const r = runs === 1 ? probe : calculate({ ...extra, typeId: item.typeId, runs });
      const job = r.jobs.at(-1)!;
      const v = volumes.get(item.typeId);
      const d = depth.get(item.typeId);
      const marketDays = v && v.avgDailyVolume30d > 0 ? r.summary.output / v.avgDailyVolume30d : null;
      const priceTrend = v?.avgPrice7d && v.avgPrice30d ? v.avgPrice7d / v.avgPrice30d - 1 : null;
      const market = { marketDays, sellOrders: d?.sellOrders ?? null, sellOrdersFresh: d?.sellOrdersFresh ?? null, priceTrend };
      if (r.prices.oldest && (!oldest || r.prices.oldest < oldest)) oldest = r.prices.oldest;
      return {
        typeId: item.typeId,
        name: item.name,
        group,
        blueprintSource:
          r.request.blueprintSource === "invention" ? "invention" : r.ownedBlueprint ? (r.ownedBlueprint.isBpo ? "bpo" : "bpc") : "none",
        runs,
        maxRuns,
        output: r.summary.output,
        profit: r.summary.profit,
        profitPerRun: r.summary.profit === null ? null : r.summary.profit / runs,
        margin: r.summary.margin,
        totalCost: r.summary.totalCost,
        iskPerHour: r.summary.profit === null || !job.timeSeconds ? null : r.summary.profit / (job.timeSeconds / 3600),
        jobSeconds: job.timeSeconds,
        unitPrice: r.summary.unitPrice,
        avgDailyVolume7d: v?.avgDailyVolume7d ?? null,
        avgDailyVolume30d: v?.avgDailyVolume30d ?? null,
        ...market,
        marketRisks: marketRisks(market),
        warnings: r.warnings.length,
        error: null,
      };
    } catch (e) {
      return {
        typeId: item.typeId, name: item.name, group, blueprintSource: null, runs: 0, maxRuns: 0, output: 0, profit: null, profitPerRun: null,
        margin: null, totalCost: 0, iskPerHour: null, jobSeconds: 0, unitPrice: null, avgDailyVolume7d: null,
        avgDailyVolume30d: null, marketDays: null, sellOrders: null, sellOrdersFresh: null, priceTrend: null, marketRisks: [],
        warnings: 0, error: (e as Error).message,
      };
    }
  });

  return {
    category,
    hint: categoryHint(sde, category, hasCharacters()) ?? (items.length ? null : "В этой категории ничего не нашлось в SDE"),
    rows,
    targetJobDays: s.targetJobDays,
    pricesOldest: oldest,
    computedMs: Date.now() - t0,
  };
}

/** Market types to refresh for a whole category, and products for volume history. */
export function refreshScope(category: CategoryKey): { priceTypes: number[]; products: number[] } {
  const items = itemsOf(category);
  const priceTypes = new Set<number>();
  for (const i of items) {
    try {
      for (const id of priceTypesFor(i.typeId)) priceTypes.add(id);
    } catch {
      /* item without recipe — skip */
    }
  }
  return { priceTypes: [...priceTypes], products: items.map((i) => i.typeId) };
}
