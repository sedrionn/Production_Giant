import {
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

const best = (rules: RigRule[], key: "material" | "time") => Math.max(0, ...rules.map((r) => r[key]));

/** Multiplier applied to base material quantity by the structure + rigs. */
export function materialMultiplier(f: FacilityProfile, activity: Activity, item?: ItemClass): number {
  const spec = STRUCTURES[f.structure];
  const role = activity === "manufacturing" ? 1 - spec.materialBonus : 1;
  // Rigs covering the same group can't be fitted twice in game; if presets overlap, take the best.
  const rig = 1 - best(applicableRigs(f, activity, item), "material") * SECURITY_RIG_MULTIPLIER[f.security];
  return role * rig;
}

/** Multiplier applied to base job time by the structure + rigs (skills separate). */
export function timeMultiplier(f: FacilityProfile, activity: Activity, item?: ItemClass): number {
  const spec = STRUCTURES[f.structure];
  const role = 1 - (spec.timeBonus[activity] ?? 0);
  const rig = 1 - best(applicableRigs(f, activity, item), "time") * SECURITY_RIG_MULTIPLIER[f.security];
  return role * rig;
}

/** Converts the stage-1 preset format ({ manufacturing: { material: "t2", time: "t1" } }) into rules. */
export function normalizeRigs(raw: unknown): RigRule[] {
  if (Array.isArray(raw)) return raw as RigRule[];
  if (!raw || typeof raw !== "object") return [];
  const out: RigRule[] = [];
  for (const [activity, setup] of Object.entries(raw as Record<string, { material?: RigTier; time?: RigTier }>)) {
    const material = RIG_MATERIAL_BONUS[setup?.material ?? "none"] ?? 0;
    const time = RIG_TIME_BONUS[setup?.time ?? "none"] ?? 0;
    if (material || time) out.push({ activity: activity as Activity, scopes: ["all"], material, time });
  }
  return out;
}

export const NPC_STATION: FacilityProfile = {
  structure: "npc_station",
  security: "high",
  rigs: [],
  facilityTax: 0.0025,
};
