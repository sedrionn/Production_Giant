/**
 * Invention / reverse engineering (T2 from T1 BPC, T3 from relics).
 * The result is a cost per BPC run that the build tree adds to the root.
 *
 * Decryptors: chance × multiplier, ME/TE/runs of the BPC + modifiers, one decryptor
 * consumed per attempt. Not modelled yet: cost of copying the T1 BPC.
 */
import { INVENTION } from "./bonuses";
import type { FacilityProfile } from "./facility";
import { estimatedItemValue, jobInstallCost } from "./jobCost";
import { acquisitionFeeRate, quotePrice, type FeeRates, type MarketQuote, type PriceMode } from "./pricing";
import type { BlueprintActivity, Decryptor } from "./types";

export interface InventionSkills {
  encryption: number;
  science1: number;
  science2: number;
}

export function inventionChance(baseProbability: number, s: InventionSkills, decryptorMultiplier = 1): number {
  const mult = 1 + s.encryption / INVENTION.encryptionDivisor + (s.science1 + s.science2) / INVENTION.scienceDivisor;
  return Math.min(1, baseProbability * mult * decryptorMultiplier);
}

export interface InventionInput {
  /** The invention activity of the source (T1 blueprint or relic). */
  invention: BlueprintActivity;
  /** Blueprint the invention yields (the root's blueprint). */
  targetBlueprintTypeId: number;
  /** Manufacturing activity of the target blueprint — its EIV drives the invention job fee. */
  targetManufacturing: BlueprintActivity;
  skills: InventionSkills;
  /** Price per attempt of the consumed source item (relic) — 0 for a T1 BPC you copy yourself. */
  sourceItemCost: number;
  quote: (typeId: number) => MarketQuote | undefined;
  adjustedPrice: (typeId: number) => number | undefined;
  materialPriceMode: PriceMode;
  fees: FeeRates;
  facility: FacilityProfile;
  costIndex: number;
  /** Optional decryptor consumed per attempt; its price comes from `quote`. */
  decryptor?: Decryptor | null;
}

export interface InventionResult {
  decryptorId: number | null;
  /** Decryptor price per attempt incl. acquisition fee (0 without decryptor). */
  decryptorCost: number;
  chance: number;
  runsPerSuccess: number;
  me: number;
  te: number;
  /** Datacores etc. per attempt, incl. acquisition fee. */
  materialsPerAttempt: number;
  jobCostPerAttempt: number;
  sourceItemCost: number;
  costPerAttempt: number;
  costPerSuccess: number;
  costPerRun: number;
  missingPrices: number[];
}

export function inventionCost(i: InventionInput): InventionResult {
  const product = i.invention.products.find((p) => p.typeId === i.targetBlueprintTypeId);
  if (!product) throw new Error(`invention ${i.invention.blueprintTypeId} does not yield ${i.targetBlueprintTypeId}`);
  const d = i.decryptor ?? null;
  const chance = inventionChance(product.probability ?? 0, i.skills, d?.probabilityMultiplier ?? 1);
  const fee = acquisitionFeeRate(i.materialPriceMode, i.fees);

  const missingPrices: number[] = [];
  let materialsPerAttempt = 0;
  for (const m of i.invention.materials) {
    const p = quotePrice(i.quote(m.typeId), i.materialPriceMode);
    if (p === null) missingPrices.push(m.typeId);
    else materialsPerAttempt += m.quantity * p * (1 + fee);
  }
  // Invention fee is based on the EIV of the item the blueprint will make (1 run).
  const { eiv } = estimatedItemValue(i.targetManufacturing.materials, 1, i.adjustedPrice);
  const jobCostPerAttempt = jobInstallCost(eiv, "invention", i.costIndex, i.facility).total;
  let decryptorCost = 0;
  if (d) {
    const p = quotePrice(i.quote(d.typeId), i.materialPriceMode);
    if (p === null) missingPrices.push(d.typeId);
    else decryptorCost = p * (1 + fee);
  }
  const costPerAttempt = materialsPerAttempt + jobCostPerAttempt + i.sourceItemCost + decryptorCost;
  const costPerSuccess = chance > 0 ? costPerAttempt / chance : Infinity;
  const runsPerSuccess = product.quantity + (d?.runs ?? 0);

  return {
    decryptorId: d?.typeId ?? null,
    decryptorCost,
    chance,
    runsPerSuccess,
    me: INVENTION.baseMe + (d?.me ?? 0),
    te: INVENTION.baseTe + (d?.te ?? 0),
    materialsPerAttempt,
    jobCostPerAttempt,
    sourceItemCost: i.sourceItemCost,
    costPerAttempt,
    costPerSuccess,
    costPerRun: costPerSuccess / runsPerSuccess,
    missingPrices,
  };
}
