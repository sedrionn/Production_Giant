import type { Activity, Blueprint } from "@/engine/types";

export interface SdeType {
  typeId: number;
  name: string;
  groupId: number;
  categoryId: number | null;
  /** Units per "portion" — relevant for reprocessing, NOT for job output. */
  portionSize: number;
  volume: number;
  published: boolean;
  marketGroupId: number | null;
  metaGroupId: number | null;
  /** 1 Caldari, 2 Minmatar, 4 Amarr, 8 Gallente… Absent in SDE imports made before 2026-10-16. */
  raceId?: number | null;
}

export interface SdeGroup {
  groupId: number;
  categoryId: number;
  name: string;
}

export interface SdeSystem {
  systemId: number;
  name: string;
  security: number | null;
}

export interface ProducerRef {
  blueprintTypeId: number;
  activity: Activity;
}

/**
 * Single interface over the SDE. Two implementations:
 *  - SqliteSdeSource: data/sde.sqlite built by `npm run sde:download` (local machine)
 *  - FixtureSdeSource: JSON subset committed in fixtures/sde (tests, cloud sessions)
 */
export interface SdeSource {
  getType(typeId: number): SdeType | undefined;
  getBlueprint(blueprintTypeId: number): Blueprint | undefined;
  /** Blueprints whose `activity` produces `productTypeId` (manufacturing/reaction/invention…). */
  findProducers(productTypeId: number, activity?: Activity): ProducerRef[];
  searchTypes(query: string, limit?: number): SdeType[];
  /** Published types that some manufacturing/reaction job produces. */
  searchBuildable(query: string, limit?: number): SdeType[];
  /** Every published type produced by `activity` (for the profitability overview). */
  listProducts(activity: "manufacturing" | "reaction"): SdeType[];
  getGroup(groupId: number): SdeGroup | undefined;
  getSystem(systemId: number): SdeSystem | undefined;
  searchSystems(query: string, limit?: number): SdeSystem[];
}

/** Shape of fixtures/sde/*.json */
export interface SdeSubset {
  meta: { source: string; build?: string | number; capturedAt: string; roots: number[] };
  types: SdeType[];
  blueprints: Blueprint[];
  systems?: SdeSystem[];
  groups?: SdeGroup[];
}
