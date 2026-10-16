import { deleteProfile, getSde, listProfiles, upsertProfile, type ProfileInput } from "@/server/data";
import { fail, int, ok } from "../_util";
import { normalizeRigs } from "@/engine/facility";
import type { RigScope } from "@/engine/bonuses";
import { ACTIVITIES } from "@/engine/types";

const STRUCTURES = ["npc_station", "raitaru", "azbel", "sotiyo", "athanor", "tatara"];
const SECURITY = ["high", "low", "null"];
const SCOPES: RigScope[] = ["all", "ships", "components", "capital_components", "structures", "equipment", "fuel"];

function withSystemNames() {
  const sde = getSde().source;
  return listProfiles().map((p) => ({ ...p, rigs: normalizeRigs(p.rigs), systemName: p.solarSystemId ? sde.getSystem(p.solarSystemId)?.name ?? null : null }));
}

export async function GET() {
  return ok(withSystemNames());
}

/** Create (no id) or update (with id). */
export async function POST(req: Request) {
  try {
    const b = (await req.json()) as ProfileInput & { id?: number };
    if (!b.name?.trim()) throw new Error("Нужно название");
    if (!STRUCTURES.includes(b.structureType)) throw new Error("Неизвестная структура");
    if (!SECURITY.includes(b.security)) throw new Error("Неизвестная зона безопасности");
    const rigs = normalizeRigs(b.rigs);
    for (const r of rigs) {
      if (!ACTIVITIES.includes(r.activity)) throw new Error(`Неизвестная работа рига: ${r.activity}`);
      if (!r.scopes?.length || r.scopes.some((x) => !SCOPES.includes(x))) throw new Error("У рига должны быть группы предметов");
      for (const v of [r.material, r.time, r.cost ?? 0]) if (!(v >= 0 && v <= 0.5)) throw new Error("Бонус рига должен быть 0..50%");
      for (const v of Object.values(r.security ?? {})) if (!(v >= 0 && v <= 5)) throw new Error("Множитель зоны должен быть 0..5");
    }
    const tax = Number(b.facilityTax ?? 0);
    if (!(tax >= 0 && tax <= 0.5)) throw new Error("Налог должен быть 0..50%");
    const sysBonus = Number(b.systemJobBonus ?? 0);
    if (!(sysBonus >= 0 && sysBonus <= 1)) throw new Error("Скидка системы должна быть 0..100%");
    upsertProfile({
      id: b.id ? int(b.id, "id", { min: 1 }) : undefined,
      name: b.name.trim(),
      structureType: b.structureType,
      security: b.security,
      rigs,
      solarSystemId: b.solarSystemId ? int(b.solarSystemId, "system", { min: 1 }) : null,
      facilityTax: tax,
      systemJobBonus: sysBonus,
      isDefault: !!b.isDefault,
    });
    return ok(withSystemNames());
  } catch (e) {
    return fail(e);
  }
}

export async function DELETE(req: Request) {
  try {
    deleteProfile(int(new URL(req.url).searchParams.get("id"), "id", { min: 1 }));
    return ok(withSystemNames());
  } catch (e) {
    return fail(e);
  }
}
