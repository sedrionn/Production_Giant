import { listCharacters, ownedBlueprintIndex, removeCharacter } from "@/server/characters";
import { getSde } from "@/server/data";
import { ssoConfig } from "@/esi/sso";
import { fail, int, ok } from "../_util";

export async function GET() {
  let ssoReady = true;
  try {
    ssoConfig();
  } catch {
    ssoReady = false;
  }
  const sde = getSde().source;
  const blueprints = [...ownedBlueprintIndex().values()]
    .map((b) => {
      const product = sde.getBlueprint(b.blueprintTypeId);
      const productId = product?.activities.manufacturing?.products[0]?.typeId ?? product?.activities.reaction?.products[0]?.typeId;
      return { ...b, name: sde.getType(b.blueprintTypeId)?.name ?? `#${b.blueprintTypeId}`, productId: productId ?? null };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return ok({ ssoReady, characters: listCharacters(), blueprints });
}

export async function DELETE(req: Request) {
  try {
    removeCharacter(int(new URL(req.url).searchParams.get("id"), "id", { min: 1 }));
    return ok({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
