import type { ActivityProduct, MaterialRequirement } from "./types";

/**
 * Quantity of one material for a job.
 *
 *   qty = max(runs, ceil(round(base × runs × (1 − ME/100) × multiplier, 2)))
 *
 * - `multiplier` is the facility multiplier (structure role × rigs), see facility.ts.
 * - The game rounds to 2 decimals before ceil. Example: base 8, 7 runs, ME 8,
 *   1% structure bonus → 51.0048 → round → 51.00 → 51 (a naive ceil gives 52).
 *   It also absorbs JS float noise.
 * - A material can never drop below 1 per run.
 * - ME is ignored for reactions (reaction formulas have no ME); pass me = 0.
 */
export function materialQuantity(base: number, runs: number, me: number, multiplier = 1): number {
  if (!Number.isInteger(runs) || runs < 1) throw new RangeError(`runs must be a positive integer, got ${runs}`);
  // Researched blueprints stop at ME 10, but special BPCs exist above it ('Whiskey' Shield Amplifier BPC: ME 15).
  if (me < 0 || me >= 100) throw new RangeError(`ME must be within 0..99, got ${me}`);
  if (base <= 0) return 0;
  const raw = base * runs * (1 - me / 100) * multiplier;
  const rounded = Math.round(raw * 100) / 100;
  return Math.max(runs, Math.ceil(rounded));
}

export interface MaterialLine {
  typeId: number;
  baseQuantity: number;
  quantity: number;
}

export function materialsForJob(
  materials: MaterialRequirement[],
  runs: number,
  me: number,
  multiplier = 1,
): MaterialLine[] {
  return materials.map((m) => ({
    typeId: m.typeId,
    baseQuantity: m.quantity,
    quantity: materialQuantity(m.quantity, runs, me, multiplier),
  }));
}

/** Units produced by `runs` runs. R.A.M.: 1 run → 100 units. */
export function outputQuantity(product: ActivityProduct, runs: number): number {
  return product.quantity * runs;
}

/**
 * Runs needed to obtain at least `units` of the product.
 * This is the fix for the old sheet's bug: 192 R.A.M. = 2 runs, not 192.
 */
export function runsNeeded(product: ActivityProduct, units: number): number {
  if (units <= 0) return 0;
  return Math.ceil(units / product.quantity);
}
