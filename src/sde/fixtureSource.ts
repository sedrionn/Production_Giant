import type { Activity, Blueprint } from "@/engine/types";
import type { ProducerRef, SdeGroup, SdeSource, SdeSubset, SdeSystem, SdeType } from "./types";

export class FixtureSdeSource implements SdeSource {
  private types = new Map<number, SdeType>();
  private blueprints = new Map<number, Blueprint>();
  private producers = new Map<number, ProducerRef[]>();
  private systems = new Map<number, SdeSystem>();
  private groups = new Map<number, SdeGroup>();

  constructor(...subsets: SdeSubset[]) {
    for (const s of subsets) {
      for (const t of s.types) this.types.set(t.typeId, t);
      for (const b of s.blueprints) this.blueprints.set(b.blueprintTypeId, b);
      for (const sys of s.systems ?? []) this.systems.set(sys.systemId, sys);
      for (const g of s.groups ?? []) this.groups.set(g.groupId, g);
    }
    for (const bp of this.blueprints.values()) {
      for (const act of Object.values(bp.activities)) {
        if (!act) continue;
        for (const p of act.products) {
          const list = this.producers.get(p.typeId) ?? [];
          list.push({ blueprintTypeId: bp.blueprintTypeId, activity: act.activity });
          this.producers.set(p.typeId, list);
        }
      }
    }
  }

  getType(typeId: number) {
    return this.types.get(typeId);
  }

  getBlueprint(blueprintTypeId: number) {
    return this.blueprints.get(blueprintTypeId);
  }

  findProducers(productTypeId: number, activity?: Activity): ProducerRef[] {
    const all = this.producers.get(productTypeId) ?? [];
    return activity ? all.filter((p) => p.activity === activity) : all;
  }

  searchTypes(query: string, limit = 20): SdeType[] {
    const q = query.toLowerCase();
    const out: SdeType[] = [];
    for (const t of this.types.values()) {
      if (t.name.toLowerCase().includes(q)) out.push(t);
      if (out.length >= limit) break;
    }
    return out;
  }

  searchBuildable(query: string, limit = 20): SdeType[] {
    return this.searchTypes(query, 10_000)
      .filter((t) => t.published && (this.findProducers(t.typeId, "manufacturing").length || this.findProducers(t.typeId, "reaction").length))
      .slice(0, limit);
  }

  getSystem(systemId: number) {
    return this.systems.get(systemId);
  }

  searchSystems(query: string, limit = 20): SdeSystem[] {
    const q = query.toLowerCase();
    return [...this.systems.values()].filter((s) => s.name.toLowerCase().includes(q)).slice(0, limit);
  }

  listProducts(activity: "manufacturing" | "reaction"): SdeType[] {
    const out = new Map<number, SdeType>();
    for (const bp of this.blueprints.values()) {
      for (const p of bp.activities[activity]?.products ?? []) {
        const t = this.types.get(p.typeId);
        if (t?.published) out.set(t.typeId, t);
      }
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  getGroup(groupId: number) {
    return this.groups.get(groupId);
  }
}
