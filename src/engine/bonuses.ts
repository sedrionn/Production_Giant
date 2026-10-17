/**
 * Every game constant the engine uses lives here — no magic numbers in formulas.
 *
 * ⚠ СВЕРИТЬ С ИГРОЙ. Values below are the commonly documented ones as of
 * 2025–2026 but CCP tweaks them. Before trusting a profit number, compare a
 * couple of items against the in-game industry window / EVE Guru and fix the
 * values here. Each value carries a `// verify` marker until confirmed.
 */
import type { Activity } from "./types";

export type StructureType =
  | "npc_station"
  | "raitaru"
  | "azbel"
  | "sotiyo"
  | "athanor"
  | "tatara";

export type Security = "high" | "low" | "null"; // "null" also covers wormholes
export type RigTier = "none" | "t1" | "t2";

/**
 * Item groups a rig can cover. Mapped from SDE categories/groups.
 * Check the rig's description in game (Show Info) to pick the right scopes.
 */
export type RigScope = "all" | "ships" | "components" | "capital_components" | "structures" | "equipment" | "fuel";

export const RIG_SCOPE_CATEGORIES: Record<RigScope, number[]> = {
  all: [],
  ships: [6], // Ship
  components: [17], // Commodity: advanced, capital, T3 (hybrid tech) components, R.A.M.
  capital_components: [],
  structures: [22, 23, 65, 66], // Deployable, Starbase, Structure, Structure Module
  equipment: [7, 8, 18, 32, 87], // Module, Charge, Drone, Subsystem, Fighter
  fuel: [],
};

export const RIG_SCOPE_GROUPS: Record<RigScope, number[]> = {
  all: [],
  ships: [],
  components: [],
  capital_components: [873], // Capital Construction Components (Thukker rigs give these an extra bonus)
  structures: [],
  equipment: [],
  fuel: [1136], // Fuel Block
};

export interface StructureSpec {
  label: string;
  /** Activities this structure can run at all. */
  activities: Activity[];
  /** Role bonus: fraction of materials saved for manufacturing (0.01 = 1%). */
  materialBonus: number;
  /** Role bonus: fraction of job time saved, keyed by activity. */
  timeBonus: Partial<Record<Activity, number>>;
  /** Role bonus: fraction of the job gross cost (EIV × index) saved. */
  jobCostBonus: number;
}

const ENGINEERING: Activity[] = [
  "manufacturing",
  "invention",
  "copying",
  "research_material",
  "research_time",
];

export const STRUCTURES: Record<StructureType, StructureSpec> = {
  npc_station: {
    label: "NPC Station",
    activities: ENGINEERING,
    materialBonus: 0,
    timeBonus: {},
    jobCostBonus: 0,
  },
  raitaru: {
    label: "Raitaru",
    activities: ENGINEERING,
    materialBonus: 0.01, // verify
    timeBonus: { manufacturing: 0.15, invention: 0.15, copying: 0.15, research_material: 0.15, research_time: 0.15 }, // verify
    jobCostBonus: 0.03, // verify
  },
  azbel: {
    label: "Azbel",
    activities: ENGINEERING,
    materialBonus: 0.01, // verify
    timeBonus: { manufacturing: 0.2, invention: 0.2, copying: 0.2, research_material: 0.2, research_time: 0.2 }, // verify
    jobCostBonus: 0.04, // verify
  },
  sotiyo: {
    label: "Sotiyo",
    activities: ENGINEERING,
    materialBonus: 0.01, // verify
    timeBonus: { manufacturing: 0.3, invention: 0.3, copying: 0.3, research_material: 0.3, research_time: 0.3 }, // ✓ in game
    jobCostBonus: 0.05, // ✓ in game ("Structure Role Bonus −5%")
  },
  athanor: {
    label: "Athanor",
    activities: ["reaction"],
    materialBonus: 0,
    timeBonus: {},
    jobCostBonus: 0,
  },
  tatara: {
    label: "Tatara",
    activities: ["reaction"],
    materialBonus: 0,
    timeBonus: { reaction: 0.25 }, // verify
    jobCostBonus: 0,
  },
};

/** Rig bonus multiplier by security band (applied to rig bonuses only). */
export const SECURITY_RIG_MULTIPLIER: Record<Security, number> = {
  high: 1.0, // verify
  low: 1.9, // ✓ in game (standard rigs; Thukker rigs differ — per-rig override)
  null: 2.1, // verify
};

/** Material-efficiency rig bonus per tier (before security multiplier). */
export const RIG_MATERIAL_BONUS: Record<RigTier, number> = {
  none: 0,
  t1: 0.02, // ✓ in game (XL T1 rig attributes)
  t2: 0.024, // verify
};

/** Time-efficiency rig bonus per tier (before security multiplier). */
export const RIG_TIME_BONUS: Record<RigTier, number> = {
  none: 0,
  t1: 0.2, // ✓ in game
  t2: 0.24, // verify
};

/** Share of EIV used as the base for the job fee, per activity. */
export const ACTIVITY_EIV_FACTOR: Record<Activity, number> = {
  manufacturing: 1,
  reaction: 1,
  invention: 0.02, // verify
  copying: 0.02, // verify
  research_material: 0.02, // verify
  research_time: 0.02, // verify
};

/** SCC surcharge, fraction of EIV, added to every job. */
export const SCC_SURCHARGE = 0.04; // ✓ in game

/** Skill time reductions per level. */
/** Skill type ids that have their own time bonus and are excluded from the 1%/level rule. */
export const SKILL_IDS = { industry: 3380, advancedIndustry: 3388, reactions: 45746 } as const;

export const SKILL_TIME = {
  industryPerLevel: 0.04, // ✓ in game — Industry
  advancedIndustryPerLevel: 0.03, // ✓ in game — Advanced Industry
  /** Every skill the blueprint requires (except Industry / Advanced Industry): 1% per level, multiplicative. ✓ in game */
  requiredSkillPerLevel: 0.01,
  reactionsPerLevel: 0.04, // verify — Reactions
} as const;

/** Market fee bases. */
export const MARKET = {
  salesTaxBase: 0.075, // verify
  accountingReductionPerLevel: 0.11, // verify — relative reduction
  brokerFeeBase: 0.03, // verify — NPC station
  brokerRelationsPerLevel: 0.003, // verify — absolute
  factionStandingFactor: 0.0003, // verify — per standing point
  corpStandingFactor: 0.0002, // verify — per standing point
} as const;

/** Invention. chance = base × (1 + encryption/40 + (science1 + science2)/30) × decryptor. */
export const INVENTION = {
  encryptionDivisor: 40, // verify
  scienceDivisor: 30, // verify
  /** ME/TE of an invented BPC without decryptor. */
  baseMe: 2, // verify
  baseTe: 4, // verify
} as const;

/** Industry activity ids as ESI reports them on jobs (SDE ramActivities). 9 is the old reactions id. // verify */
export const JOB_ACTIVITY_IDS = { manufacturing: 1, researchTime: 3, researchMaterial: 4, copying: 5, invention: 8, reactions: [9, 11] } as const;

/** Parallel job slots: 1 + level of each skill below. Standard EVE rule. // verify */
export const SLOT_SKILLS = {
  manufacturing: [3387, 24625], // Mass Production, Advanced Mass Production
  reaction: [45748, 45749], // Mass Reactions, Advanced Mass Reactions
  science: [3406, 24624], // Laboratory Operation, Advanced Laboratory Operation
} as const;
