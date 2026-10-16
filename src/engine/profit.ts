import { quotePrice, saleFeeRate, type FeeRates, type MarketQuote, type PriceMode } from "./pricing";
import type { TreeResult } from "./tree";

export interface ProfitSummary {
  output: number;
  materialCost: number;
  jobCost: number;
  /** Leftover intermediates kept for later, subtracted from the cost (see TreeResult.surplusCredit). */
  surplusCredit: number;
  /** Blueprint cost (invention) for the runs, 0 for owned BPO. */
  blueprintCost: number;
  totalCost: number;
  costPerUnit: number;
  unitPrice: number | null;
  grossRevenue: number | null;
  saleFees: number | null;
  profit: number | null;
  margin: number | null;
  totalJobSeconds: number;
  iskPerHour: number | null;
}

export function summarizeProfit(
  tree: TreeResult,
  productQuote: MarketQuote | undefined,
  productPriceMode: PriceMode,
  fees: FeeRates,
  blueprintCostPerRun = 0,
): ProfitSummary {
  const blueprintCost = blueprintCostPerRun * tree.rootRuns;
  const totalCost = tree.totalCost + blueprintCost;
  const unitPrice = quotePrice(productQuote, productPriceMode);
  const grossRevenue = unitPrice === null ? null : unitPrice * tree.output;
  const saleFees = grossRevenue === null ? null : grossRevenue * saleFeeRate(productPriceMode, fees);
  const profit = grossRevenue === null || saleFees === null ? null : grossRevenue - saleFees - totalCost;
  return {
    output: tree.output,
    materialCost: tree.materialCost,
    jobCost: tree.jobCost,
    surplusCredit: tree.surplusCredit,
    blueprintCost,
    totalCost,
    costPerUnit: tree.output ? totalCost / tree.output : 0,
    unitPrice,
    grossRevenue,
    saleFees,
    profit,
    margin: profit === null || totalCost === 0 ? null : profit / totalCost,
    totalJobSeconds: tree.totalJobSeconds,
    iskPerHour: profit === null || tree.totalJobSeconds === 0 ? null : profit / (tree.totalJobSeconds / 3600),
  };
}
