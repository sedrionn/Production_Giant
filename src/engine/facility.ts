import {
  RIG_MATERIAL_BONUS,
  RIG_TIME_BONUS,
  SECURITY_RIG_MULTIPLIER,
  STRUCTURES,
  type RigTier,
  type Security,
  type StructureType,
} from "./bonuses";
import type { Activity } from "./types";

export interface RigSetup {
  material: RigTier;
  time: RigTier;
}

/**
 * A structure preset: structure + rigs + where it stands + tax.
 *
 * Simplification (stage 1): one rig tier per activity. In game, rigs cover
 * item groups (ships, modules, components…). Per-group rigs come later.
 */
export interface FacilityProfile {
  structure: StructureType;
  security: Security;
  rigs: Partial<Record<Activity, RigSetup>>;
  /** Owner-set facility tax, fraction of EIV (0.01 = 1%). NPC stations: 0.0025. */
  facilityTax: number;
}

export class FacilityError extends Error {}

export function assertSupports(f: FacilityProfile, activity: Activity): void {
  if (!STRUCTURES[f.structure].activities.includes(activity)) {
    throw new FacilityError(`${STRUCTURES[f.structure].label} cannot run ${activity}`);
  }
}

/** Multiplier applied to base material quantity by the structure + rigs. */
export function materialMultiplier(f: FacilityProfile, activity: Activity): number {
  const spec = STRUCTURES[f.structure];
  const role = activity === "manufacturing" ? 1 - spec.materialBonus : 1;
  const tier = f.rigs[activity]?.material ?? "none";
  const rig = 1 - RIG_MATERIAL_BONUS[tier] * SECURITY_RIG_MULTIPLIER[f.security];
  return role * rig;
}

/** Multiplier applied to base job time by the structure + rigs (skills separate). */
export function timeMultiplier(f: FacilityProfile, activity: Activity): number {
  const spec = STRUCTURES[f.structure];
  const role = 1 - (spec.timeBonus[activity] ?? 0);
  const tier = f.rigs[activity]?.time ?? "none";
  const rig = 1 - RIG_TIME_BONUS[tier] * SECURITY_RIG_MULTIPLIER[f.security];
  return role * rig;
}

export const NPC_STATION: FacilityProfile = {
  structure: "npc_station",
  security: "high",
  rigs: {},
  facilityTax: 0.0025,
};
