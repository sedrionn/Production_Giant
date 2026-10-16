/**
 * Core data shapes shared by the engine. These mirror the SDE but are
 * deliberately minimal: the engine never reads the SDE itself, callers pass
 * data in.
 */

export type Activity =
  | "manufacturing"
  | "reaction"
  | "invention"
  | "copying"
  | "research_material"
  | "research_time";

export const ACTIVITIES: readonly Activity[] = [
  "manufacturing",
  "reaction",
  "invention",
  "copying",
  "research_material",
  "research_time",
] as const;

export interface MaterialRequirement {
  typeId: number;
  /** Base quantity per run, before ME and any bonuses. */
  quantity: number;
}

export interface ActivityProduct {
  typeId: number;
  /** Units produced per run (portion size), e.g. 100 for R.A.M.- Starship Tech. */
  quantity: number;
  /** Base success chance, only for invention. */
  probability?: number;
}

export interface SkillRequirement {
  typeId: number;
  level: number;
}

export interface BlueprintActivity {
  blueprintTypeId: number;
  activity: Activity;
  /** Base time per run in seconds. */
  time: number;
  materials: MaterialRequirement[];
  products: ActivityProduct[];
  skills: SkillRequirement[];
}

/** Invention decryptor, values straight from the SDE dogma attributes. */
export interface Decryptor {
  typeId: number;
  name: string;
  /** Multiplies the invention chance (e.g. 1.1 = +10%). */
  probabilityMultiplier: number;
  /** Added to the invented BPC's ME / TE / runs. */
  me: number;
  te: number;
  runs: number;
}

export interface Blueprint {
  blueprintTypeId: number;
  maxProductionLimit: number;
  activities: Partial<Record<Activity, BlueprintActivity>>;
}
