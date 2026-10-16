import type { BlueprintActivity } from "@/engine/types";
import type { SdeSource } from "./types";

/**
 * Recipe lookup for the build tree: which manufacturing/reaction activity makes a type.
 * If several blueprints make the same item (rare: faction/limited variants), the first
 * published manufacturing one wins; reactions are used only when no manufacturing exists.
 */
export function recipeLookup(sde: SdeSource): (typeId: number) => BlueprintActivity | undefined {
  const cache = new Map<number, BlueprintActivity | undefined>();
  return (typeId) => {
    if (cache.has(typeId)) return cache.get(typeId);
    let found: BlueprintActivity | undefined;
    for (const activity of ["manufacturing", "reaction"] as const) {
      const refs = sde.findProducers(typeId, activity);
      const published = refs.filter((r) => sde.getType(r.blueprintTypeId)?.published !== false);
      const ref = published[0] ?? refs[0];
      if (ref) {
        found = sde.getBlueprint(ref.blueprintTypeId)?.activities[activity];
        if (found) break;
      }
    }
    cache.set(typeId, found);
    return found;
  };
}
