/**
 * Single-blueprint calculator (stage 1): one job, buy every input.
 * The full build tree (build vs buy per node, reactions, invention, stock)
 * comes in stage 1c on top of these same pieces.
 */
import { assertSupports, materialMultiplier, type FacilityProfile, type ItemClass } from "./facility";
import { estimatedItemValue, jobInstallCost, jobTime, type IndustrySkills, type JobCostBreakdown } from "./jobCost";
import { materialsForJob, outputQuantity } from "./materials";
import {
  acquisitionFeeRate,
  quotePrice,
  saleFeeRate,
  type FeeRates,
  type MarketQuote,
  type PriceMode,
} from "./pricing";
import type { BlueprintActivity } from "./types";

export interface CalcInput {
  activity: BlueprintActivity;
  runs: number;
  me: number;
  te: number;
  facility: FacilityProfile;
  /** Product's category/group — decides which rigs apply. */
  productClass?: ItemClass;
  systemCostIndex: number;
  skills?: IndustrySkills;
  quotes: (typeId: number) => MarketQuote | undefined;
  adjustedPrice: (typeId: number) => number | undefined;
  materialPriceMode: PriceMode;
  productPriceMode: PriceMode;
  fees: FeeRates;
}

export interface CalcMaterialLine {
  typeId: number;
  baseQuantity: number;
  quantity: number;
  unitPrice: number | null;
  /** quantity × unitPrice × (1 + acquisition fee); null when unpriced. */
  totalCost: number | null;
}

export interface CalcResult {
  productTypeId: number;
  outputUnits: number;
  materials: CalcMaterialLine[];
  materialCost: number;
  job: JobCostBreakdown;
  totalCost: number;
  costPerUnit: number;
  productUnitPrice: number | null;
  grossRevenue: number | null;
  saleFees: number | null;
  netRevenue: number | null;
  profit: number | null;
  /** profit / totalCost */
  margin: number | null;
  timeSeconds: number;
  iskPerHour: number | null;
  warnings: string[];
}

export function calculateJob(input: CalcInput): CalcResult {
  const { activity: act, runs, facility } = input;
  assertSupports(facility, act.activity);
  const product = act.products[0];
  if (!product) throw new Error(`blueprint ${act.blueprintTypeId} has no product for ${act.activity}`);

  const warnings: string[] = [];
  const me = act.activity === "manufacturing" ? input.me : 0;
  const mult = materialMultiplier(facility, act.activity, input.productClass);
  const acqFee = acquisitionFeeRate(input.materialPriceMode, input.fees);

  const materials: CalcMaterialLine[] = materialsForJob(act.materials, runs, me, mult).map((m) => {
    const unitPrice = quotePrice(input.quotes(m.typeId), input.materialPriceMode);
    if (unitPrice === null) warnings.push(`no market price for material ${m.typeId}`);
    return {
      ...m,
      unitPrice,
      totalCost: unitPrice === null ? null : m.quantity * unitPrice * (1 + acqFee),
    };
  });
  const materialCost = materials.reduce((s, m) => s + (m.totalCost ?? 0), 0);

  const { eiv, missing } = estimatedItemValue(act.materials, runs, input.adjustedPrice);
  if (missing.length) warnings.push(`no adjusted price for ${missing.join(", ")} (job cost understated)`);
  const job = jobInstallCost(eiv, act.activity, input.systemCostIndex, facility);

  const outputUnits = outputQuantity(product, runs);
  const totalCost = materialCost + job.total;
  const productUnitPrice = quotePrice(input.quotes(product.typeId), input.productPriceMode);
  if (productUnitPrice === null) warnings.push(`no market price for product ${product.typeId}`);

  const grossRevenue = productUnitPrice === null ? null : productUnitPrice * outputUnits;
  const saleFees = grossRevenue === null ? null : grossRevenue * saleFeeRate(input.productPriceMode, input.fees);
  const netRevenue = grossRevenue === null || saleFees === null ? null : grossRevenue - saleFees;
  const profit = netRevenue === null ? null : netRevenue - totalCost;
  const timeSeconds = jobTime(act.time, runs, input.te, act.activity, facility, input.skills, input.productClass, act.skills);

  return {
    productTypeId: product.typeId,
    outputUnits,
    materials,
    materialCost,
    job,
    totalCost,
    costPerUnit: totalCost / outputUnits,
    productUnitPrice,
    grossRevenue,
    saleFees,
    netRevenue,
    profit,
    margin: profit === null || totalCost === 0 ? null : profit / totalCost,
    timeSeconds,
    iskPerHour: profit === null || timeSeconds === 0 ? null : profit / (timeSeconds / 3600),
    warnings,
  };
}
