import type { Activity } from "@/engine/types";
import type { SdeSource } from "./types";

export interface CollectedTree {
  typeIds: Set<number>;
  blueprintIds: Set<number>;
  /** Types that have no producer in the SDE → must be bought (minerals, PI, moon goo, salvage…). */
  leafTypeIds: Set<number>;
}

const BUILD_ACTIVITIES: Activity[] = ["manufacturing", "reaction"];

/**
 * Walks the full production tree below `roots`:
 *  product → manufacturing/reaction blueprint → its materials → … down to raw materials,
 *  plus invention sources for each blueprint (T2/T3 BPCs, datacores, decryptor-free).
 * Used to cut a small SDE subset for fixtures, and later by the build tree.
 */
export function collectTree(sde: SdeSource, roots: number[], opts: { invention?: boolean } = {}): CollectedTree {
  const invention = opts.invention ?? true;
  const typeIds = new Set<number>();
  const blueprintIds = new Set<number>();
  const leafTypeIds = new Set<number>();
  const visited = new Set<number>();
  const queue = [...roots];

  const addBlueprint = (bpId: number) => {
    if (blueprintIds.has(bpId)) return;
    blueprintIds.add(bpId);
    typeIds.add(bpId);
    const bp = sde.getBlueprint(bpId);
    if (!bp) return;
    for (const act of Object.values(bp.activities)) {
      if (!act) continue;
      if (BUILD_ACTIVITIES.includes(act.activity)) for (const m of act.materials) queue.push(m.typeId);
      if (act.activity === "invention") for (const m of act.materials) typeIds.add(m.typeId);
      for (const s of act.skills) typeIds.add(s.typeId);
    }
    if (invention) {
      for (const src of sde.findProducers(bpId, "invention")) {
        addBlueprint(src.blueprintTypeId);
      }
    }
  };

  while (queue.length) {
    const typeId = queue.pop()!;
    if (visited.has(typeId)) continue;
    visited.add(typeId);
    typeIds.add(typeId);
    const producers = BUILD_ACTIVITIES.flatMap((a) => sde.findProducers(typeId, a));
    if (producers.length === 0) leafTypeIds.add(typeId);
    for (const p of producers) addBlueprint(p.blueprintTypeId);
  }

  // Invention-source blueprints pull in their own products (e.g. the T1 item), which is fine,
  // but they are not leaves of the build tree.
  for (const id of blueprintIds) leafTypeIds.delete(id);
  return { typeIds, blueprintIds, leafTypeIds };
}
