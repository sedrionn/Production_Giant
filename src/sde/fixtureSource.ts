import type { Activity, Blueprint } from "@/engine/types";
import type { ProducerRef, SdeSource, SdeSubset, SdeType } from "./types";

export class FixtureSdeSource implements SdeSource {
  private types = new Map<number, SdeType>();
  private blueprints = new Map<number, Blueprint>();
  private producers = new Map<number, ProducerRef[]>();

  constructor(...subsets: SdeSubset[]) {
    for (const s of subsets) {
      for (const t of s.types) this.types.set(t.typeId, t);
      for (const b of s.blueprints) this.blueprints.set(b.blueprintTypeId, b);
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
}
