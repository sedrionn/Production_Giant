import {
  defaultRigSecurity,
  RIG_MATERIAL_BONUS,
  RIG_TIME_BONUS,
  RIG_SCOPE_CATEGORIES,
  RIG_SCOPE_GROUPS,
  SECURITY_RIG_MULTIPLIER,
  STRUCTURES,
  type RigScope,
  type RigTier,
  type Security,
  type StructureType,
} from "./bonuses";
import type { Activity } from "./types";

/**
 * One fitted rig. Bonuses are the rig's BASE values as shown in-game
 * (Show Info → Attributes on the rig item), before the security multiplier.
 * Example: Standup XL-Set Ship Manufacturing Efficiency I →
 *   { activity: "manufacturing", scopes: ["ships"], material: 0.02, time: 0.2 }
 */
export interface RigRule {
  name?: string;
  activity: Activity;
  /** Item groups the rig affects; "all" = every product of that activity. */
  scopes: RigScope[];
  /** Fraction, 0.02 = 2% fewer materials (before security multiplier). */
  material: number;
  /** Fraction, 0.2 = 20% faster (before security multiplier). */
  time: number;
  /** Fraction off the cost-index part of the job fee (e.g. Lab Optimization −10%), before security multiplier. */
  cost?: number;
  /**
   * The rig's own security multipliers (Show Info → "High/Low/Nullsec Bonus Multiplier").
   * Standard rigs: 1 / 1.9 / 2.1. Thukker rigs: 0.1 / 1.9 / 0.1. Omitted = standard.
   */
  security?: Partial<Record<Security, number>>;
}

/** What the product of a job is — rigs only affect some item groups. */
export interface ItemClass {
  categoryId: number | null;
  groupId: number;
}

/** A structure preset: structure + rigs + where it stands + taxes. */
export interface FacilityProfile {
  structure: StructureType;
  security: Security;
  rigs: RigRule[];
  /** Owner-set facility tax, fraction of EIV (0.01 = 1%). NPC stations: 0.0025. */
  facilityTax: number;
  /**
   * Extra system-wide discount on the cost-index part of the job fee
   * (e.g. Faction Warfare system bonus), fraction: 0.5 = −50%. Verify against the
   * in-game job cost tooltip — CCP's exact rule is not confirmed here.
   */
  systemJobBonus?: number;
}

export class FacilityError extends Error {}

export function assertSupports(f: FacilityProfile, activity: Activity): void {
  if (!STRUCTURES[f.structure].activities.includes(activity)) {
    throw new FacilityError(`${STRUCTURES[f.structure].label} cannot run ${activity}`);
  }
}

export function scopesOf(item: ItemClass | undefined): Set<RigScope> {
  const out = new Set<RigScope>(["all"]);
  if (!item) return out;
  for (const [scope, cats] of Object.entries(RIG_SCOPE_CATEGORIES) as [RigScope, number[]][]) {
    if (item.categoryId !== null && cats.includes(item.categoryId)) out.add(scope);
  }
  for (const [scope, groups] of Object.entries(RIG_SCOPE_GROUPS) as [RigScope, number[]][]) {
    if (groups.includes(item.groupId)) out.add(scope);
  }
  return out;
}

/** Rigs that apply to this activity and product. Without an item class only "all" rigs apply. */
export function applicableRigs(f: FacilityProfile, activity: Activity, item?: ItemClass): RigRule[] {
  const scopes = scopesOf(item);
  return f.rigs.filter((r) => r.activity === activity && r.scopes.some((s) => scopes.has(s)));
}

/** Effective bonus of one rig in this security band. */
export function rigBonus(r: RigRule, key: "material" | "time" | "cost", security: Security): number {
  return (r[key] ?? 0) * (r.security?.[security] ?? defaultRigSecurity(r.activity)[security]);
}

// Rigs covering the same group can't be fitted twice in game; overlapping rules
// (e.g. Thukker's general + capital-component bonus) → the best one wins.
const best = (rules: RigRule[], key: "material" | "time" | "cost", security: Security) =>
  Math.max(0, ...rules.map((r) => rigBonus(r, key, security)));

/** Multiplier applied to base material quantity by the structure + rigs. */
export function materialMultiplier(f: FacilityProfile, activity: Activity, item?: ItemClass): number {
  const spec = STRUCTURES[f.structure];
  const role = activity === "manufacturing" ? 1 - spec.materialBonus : 1;
  const rig = 1 - best(applicableRigs(f, activity, item), "material", f.security);
  return role * rig;
}

/** Multiplier applied to base job time by the structure + rigs (skills separate). */
export function timeMultiplier(f: FacilityProfile, activity: Activity, item?: ItemClass): number {
  const spec = STRUCTURES[f.structure];
  const role = 1 - (spec.timeBonus[activity] ?? 0);
  const rig = 1 - best(applicableRigs(f, activity, item), "time", f.security);
  return role * rig;
}

/** Multiplier on the cost-index part of the job fee from rigs (structure role bonus is separate). */
export function costMultiplier(f: FacilityProfile, activity: Activity, item?: ItemClass): number {
  return 1 - best(applicableRigs(f, activity, item), "cost", f.security);
}

/** Converts the stage-1 preset format ({ manufacturing: { material: "t2", time: "t1" } }) into rules. */
export function normalizeRigs(raw: unknown): RigRule[] {
  if (Array.isArray(raw)) return (raw as RigRule[]).map(fixReactionSecurity);
  if (!raw || typeof raw !== "object") return [];
  const out: RigRule[] = [];
  for (const [activity, setup] of Object.entries(raw as Record<string, { material?: RigTier; time?: RigTier }>)) {
    const material = RIG_MATERIAL_BONUS[setup?.material ?? "none"] ?? 0;
    const time = RIG_TIME_BONUS[setup?.time ?? "none"] ?? 0;
    if (material || time) out.push({ activity: activity as Activity, scopes: ["all"], material, time });
  }
  return out;
}

/**
 * Older presets saved reaction rigs with the standard ×1 / ×1.9 / ×2.1 multipliers (the editor
 * filled them in). No reactor rig has those, so such a rule falls back to the reactor defaults.
 */
function fixReactionSecurity(r: RigRule): RigRule {
  if (r.activity !== "reaction" || !r.security) return r;
  const std = (["high", "low", "null"] as const).every((z) => r.security?.[z] === SECURITY_RIG_MULTIPLIER[z]);
  if (!std) return r;
  const rest = { ...r };
  delete rest.security;
  return rest;
}

export const NPC_STATION: FacilityProfile = {
  structure: "npc_station",
  security: "high",
  rigs: [],
  facilityTax: 0.0025,
};
