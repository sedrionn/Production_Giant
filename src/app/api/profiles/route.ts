import { deleteProfile, getSde, listProfiles, upsertProfile, type ProfileInput } from "@/server/data";
import { fail, int, ok } from "../_util";

const STRUCTURES = ["npc_station", "raitaru", "azbel", "sotiyo", "athanor", "tatara"];
const SECURITY = ["high", "low", "null"];
const TIERS = ["none", "t1", "t2"];

function withSystemNames() {
  const sde = getSde().source;
  return listProfiles().map((p) => ({ ...p, systemName: p.solarSystemId ? sde.getSystem(p.solarSystemId)?.name ?? null : null }));
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
    for (const r of Object.values(b.rigs ?? {})) {
      if (r && (!TIERS.includes(r.material) || !TIERS.includes(r.time))) throw new Error("Неверный тир рига");
    }
    const tax = Number(b.facilityTax ?? 0);
    if (!(tax >= 0 && tax <= 0.5)) throw new Error("Налог должен быть 0..50%");
    upsertProfile({
      id: b.id ? int(b.id, "id", { min: 1 }) : undefined,
      name: b.name.trim(),
      structureType: b.structureType,
      security: b.security,
      rigs: b.rigs ?? {},
      solarSystemId: b.solarSystemId ? int(b.solarSystemId, "system", { min: 1 }) : null,
      facilityTax: tax,
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
