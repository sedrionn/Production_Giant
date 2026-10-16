/**
 * Profitability overview: one full-tree calculation per item of a category,
 * with the batch sized so the product's job runs ~targetJobDays.
 */
import { calculate, priceTypesFor, type CalcRequest } from "./calculate";
import { categoryHint, listCategory, type CategoryKey } from "./catalog";
import { getSde, getSettings, volumesFor } from "./data";

export interface OverviewRow {
  typeId: number;
  name: string;
  group: string;
  /** "invention" | "owned" | null when the item can't be calculated. */
  blueprintSource: string | null;
  runs: number;
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
  return listCategory(getSde().source, category);
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
  let oldest: string | null = null;

  const rows: OverviewRow[] = items.map((item) => {
    const group = sde.getGroup(item.groupId)?.name ?? "";
    try {
      // Pass 1: one run to learn the product's job time and blueprint limit.
      const probe = calculate({ ...extra, typeId: item.typeId, runs: 1 });
      const rootJob = probe.jobs.at(-1)!;
      const bp = sde.getBlueprint(rootJob.blueprintTypeId);
      const invented = probe.request.blueprintSource === "invention" ? probe.invention.chosen?.runsPerSuccess ?? 0 : 0;
      const maxRuns = invented || bp?.maxProductionLimit || 0;
      const runs = batchRuns(rootJob.timeSeconds, s.targetJobDays, maxRuns);
      const r = runs === 1 ? probe : calculate({ ...extra, typeId: item.typeId, runs });
      const job = r.jobs.at(-1)!;
      const v = volumes.get(item.typeId);
      if (r.prices.oldest && (!oldest || r.prices.oldest < oldest)) oldest = r.prices.oldest;
      return {
        typeId: item.typeId,
        name: item.name,
        group,
        blueprintSource: r.request.blueprintSource,
        runs,
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
        marketDays: v && v.avgDailyVolume30d > 0 ? r.summary.output / v.avgDailyVolume30d : null,
        warnings: r.warnings.length,
        error: null,
      };
    } catch (e) {
      return {
        typeId: item.typeId, name: item.name, group, blueprintSource: null, runs: 0, output: 0, profit: null, profitPerRun: null,
        margin: null, totalCost: 0, iskPerHour: null, jobSeconds: 0, unitPrice: null, avgDailyVolume7d: null,
        avgDailyVolume30d: null, marketDays: null, warnings: 0, error: (e as Error).message,
      };
    }
  });

  return {
    category,
    hint: categoryHint(sde, category) ?? (items.length ? null : "В этой категории ничего не нашлось в SDE"),
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
