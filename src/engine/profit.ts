import type { RealisticPrice } from "./marketSanity";
import { saleFeeRate, type FeeRates, type PriceMode } from "./pricing";
import type { TreeResult } from "./tree";

export interface ProfitSummary {
  output: number;
  materialCost: number;
  jobCost: number;
  /** Leftover intermediates kept for later, subtracted from the cost (see TreeResult.surplusCredit). */
  surplusCredit: number;
  /** Freight: bought materials to the factory + the product to the market. */
  shippingCost: number;
  /** Blueprint cost (invention) for the runs, 0 for owned BPO. */
  blueprintCost: number;
  totalCost: number;
  costPerUnit: number;
  /** Sale price per unit after the market sanity check (see marketSanity.ts). */
  unitPrice: number | null;
  /** The order-book price, the history reference and why the price was cut. */
  priceCheck: Omit<RealisticPrice, "price">;
  grossRevenue: number | null;
  saleFees: number | null;
  profit: number | null;
  margin: number | null;
  totalJobSeconds: number;
  iskPerHour: number | null;
}

export function summarizeProfit(
  tree: TreeResult,
  /** Product sale price from realisticPrice (one place for the sanity rules). */
  sale: RealisticPrice,
  productPriceMode: PriceMode,
  fees: FeeRates,
  blueprintCostPerRun = 0,
  /** Freight of one unit of product to the market (volume × ISK/m³). */
  productFreightPerUnit = 0,
): ProfitSummary {
  const blueprintCost = blueprintCostPerRun * tree.rootRuns;
  const productFreight = productFreightPerUnit * tree.output;
  const totalCost = tree.totalCost + blueprintCost + productFreight;
  const { price: unitPrice, ...priceCheck } = sale;
  const grossRevenue = unitPrice === null ? null : unitPrice * tree.output;
  const saleFees = grossRevenue === null ? null : grossRevenue * saleFeeRate(productPriceMode, fees);
  const profit = grossRevenue === null || saleFees === null ? null : grossRevenue - saleFees - totalCost;
  return {
    output: tree.output,
    materialCost: tree.materialCost,
    jobCost: tree.jobCost,
    surplusCredit: tree.surplusCredit,
    shippingCost: tree.freightCost + productFreight,
    blueprintCost,
    totalCost,
    costPerUnit: tree.output ? totalCost / tree.output : 0,
    unitPrice,
    priceCheck,
    grossRevenue,
    saleFees,
    profit,
    margin: profit === null || totalCost === 0 ? null : profit / totalCost,
    totalJobSeconds: tree.totalJobSeconds,
    iskPerHour: profit === null || tree.totalJobSeconds === 0 ? null : profit / (tree.totalJobSeconds / 3600),
  };
}
