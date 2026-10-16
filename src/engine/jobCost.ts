import { ACTIVITY_EIV_FACTOR, SCC_SURCHARGE, SKILL_IDS, SKILL_TIME, STRUCTURES } from "./bonuses";
import type { FacilityProfile } from "./facility";
import { timeMultiplier, type ItemClass } from "./facility";
import type { Activity, MaterialRequirement, SkillRequirement } from "./types";

export type PriceLookup = (typeId: number) => number | undefined;

/**
 * Estimated Item Value of a job: Σ(base qty × adjusted price) × runs.
 * Uses BASE quantities — ME does not change the job fee.
 * Missing adjusted prices count as 0 and are reported.
 */
export function estimatedItemValue(
  materials: MaterialRequirement[],
  runs: number,
  adjustedPrice: PriceLookup,
): { eiv: number; missing: number[] } {
  let eiv = 0;
  const missing: number[] = [];
  for (const m of materials) {
    const p = adjustedPrice(m.typeId);
    if (p === undefined) missing.push(m.typeId);
    else eiv += m.quantity * p * runs;
  }
  return { eiv, missing };
}

export interface JobCostBreakdown {
  eiv: number;
  /** EIV × activity factor × system cost index × (1 − structure bonus). */
  grossCost: number;
  facilityTax: number;
  sccSurcharge: number;
  total: number;
}

/**
 * Job installation fee.
 *   base   = EIV × activityFactor
 *   gross  = base × costIndex × (1 − structureJobBonus) × (1 − systemJobBonus)
 *   taxes  = base × (facilityTax + SCC)
 */
export function jobInstallCost(
  eiv: number,
  activity: Activity,
  systemCostIndex: number,
  facility: FacilityProfile,
): JobCostBreakdown {
  const base = eiv * ACTIVITY_EIV_FACTOR[activity];
  const grossCost =
    base * systemCostIndex * (1 - STRUCTURES[facility.structure].jobCostBonus) * (1 - (facility.systemJobBonus ?? 0));
  const facilityTax = base * facility.facilityTax;
  const sccSurcharge = base * SCC_SURCHARGE;
  return { eiv, grossCost, facilityTax, sccSurcharge, total: grossCost + facilityTax + sccSurcharge };
}

export interface IndustrySkills {
  industry?: number;
  advancedIndustry?: number;
  reactions?: number;
  /** Level assumed for every other skill the blueprint requires (until characters are synced). */
  blueprintSkills?: number;
}

/**
 * Skills time multiplier. Manufacturing: Industry 4%/lvl × Advanced Industry 3%/lvl ×
 * 1%/lvl for every other required skill of the blueprint (confirmed in game: Jackdaw
 * with all V = −41.7%).
 */
export function skillTimeMultiplier(activity: Activity, s: IndustrySkills, required: SkillRequirement[] = []): number {
  if (activity === "reaction") return 1 - SKILL_TIME.reactionsPerLevel * (s.reactions ?? 0);
  if (activity !== "manufacturing") return 1;
  let m =
    (1 - SKILL_TIME.industryPerLevel * (s.industry ?? 0)) *
    (1 - SKILL_TIME.advancedIndustryPerLevel * (s.advancedIndustry ?? 0));
  const own = new Set<number>(Object.values(SKILL_IDS));
  for (const r of required) {
    if (!own.has(r.typeId)) m *= 1 - SKILL_TIME.requiredSkillPerLevel * (s.blueprintSkills ?? 0);
  }
  return m;
}

/** Job duration in seconds for `runs` runs. */
export function jobTime(
  baseTimePerRun: number,
  runs: number,
  te: number,
  activity: Activity,
  facility: FacilityProfile,
  skills: IndustrySkills = {},
  item?: ItemClass,
  requiredSkills: SkillRequirement[] = [],
): number {
  if (te < 0 || te > 20) throw new RangeError(`TE must be within 0..20, got ${te}`);
  const teMult = activity === "manufacturing" ? 1 - te / 100 : 1;
  return baseTimePerRun * runs * teMult * timeMultiplier(facility, activity, item) * skillTimeMultiplier(activity, skills, requiredSkills);
}
