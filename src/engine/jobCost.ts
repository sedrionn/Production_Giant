import { ACTIVITY_EIV_FACTOR, SCC_SURCHARGE, SKILL_IDS, SKILL_TIME, STRUCTURES, COPYING } from "./bonuses";
import type { FacilityProfile } from "./facility";
import { costMultiplier, timeMultiplier, type ItemClass } from "./facility";
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
 *   gross  = base × costIndex × (1 − structureJobBonus) × (1 − rigCostBonus) × (1 − systemJobBonus)
 *   taxes  = base × (facilityTax + SCC)
 */
export function jobInstallCost(
  eiv: number,
  activity: Activity,
  systemCostIndex: number,
  facility: FacilityProfile,
  item?: ItemClass,
): JobCostBreakdown {
  const base = eiv * ACTIVITY_EIV_FACTOR[activity];
  const grossCost =
    base *
    systemCostIndex *
    (1 - STRUCTURES[facility.structure].jobCostBonus) *
    costMultiplier(facility, activity, item) *
    (1 - (facility.systemJobBonus ?? 0));
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
  /** Real levels by skill type id (from a synced character); wins over blueprintSkills. */
  levels?: Record<number, number>;
  /**
   * Time bonus per level of each skill, as a fraction (SDE dogma, e.g. 0.01 for the science skills).
   * Skills not listed give nothing (rigging, ship skills). Absent = legacy rule: 1% for every required skill.
   */
  timeBonusPerLevel?: Record<number, number>;
}

/**
 * Skills time multiplier. Manufacturing: Industry 4%/lvl × Advanced Industry 3%/lvl ×
 * the bonus of every other required skill that has one — 1%/lvl for science skills
 * (confirmed in game: Jackdaw with all V = −41.7%; EVE Guru: Shield Rigging on T2 rigs gives nothing).
 * Science jobs (invention, copying, research): Advanced Industry; copying also Science 5%/lvl.
 */
export function skillTimeMultiplier(activity: Activity, s: IndustrySkills, required: SkillRequirement[] = []): number {
  if (activity === "reaction") return 1 - SKILL_TIME.reactionsPerLevel * (s.reactions ?? 0);
  if (activity !== "manufacturing") {
    const adv = SKILL_TIME.advancedIndustryScience ? 1 - SKILL_TIME.advancedIndustryPerLevel * (s.advancedIndustry ?? 0) : 1;
    if (activity !== "copying") return adv;
    const science = s.levels ? (s.levels[COPYING.scienceSkillId] ?? 0) : (s.blueprintSkills ?? 0);
    return adv * (1 - COPYING.sciencePerLevel * science);
  }
  let m =
    (1 - SKILL_TIME.industryPerLevel * (s.industry ?? 0)) *
    (1 - SKILL_TIME.advancedIndustryPerLevel * (s.advancedIndustry ?? 0));
  const own = new Set<number>(Object.values(SKILL_IDS));
  for (const r of required) {
    if (own.has(r.typeId)) continue;
    const level = s.levels ? (s.levels[r.typeId] ?? 0) : (s.blueprintSkills ?? 0);
    const perLevel = s.timeBonusPerLevel ? (s.timeBonusPerLevel[r.typeId] ?? 0) : SKILL_TIME.requiredSkillPerLevel;
    m *= 1 - perLevel * level;
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
  // Researched blueprints stop at TE 20; special BPCs may go higher (see materials.ts).
  if (te < 0 || te >= 100) throw new RangeError(`TE must be within 0..99, got ${te}`);
  const teMult = activity === "manufacturing" ? 1 - te / 100 : 1;
  return baseTimePerRun * runs * teMult * timeMultiplier(facility, activity, item) * skillTimeMultiplier(activity, skills, requiredSkills);
}
