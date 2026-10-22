/**
 * Item lists for the profitability overview. Each category is a filter over SDE
 * products; "mine" (owned blueprints) is added on top when characters are synced.
 */
import { recipeLookup } from "@/sde/recipes";
import type { SdeSource, SdeType } from "@/sde/types";

export type CategoryKey = "mine" | "caldari_t1" | "caldari_t2" | "t3" | "components" | "other" | "reactions" | "rigs_t1" | "rigs_t2" | "warp_disruptors";

export const RACE_CALDARI = 1;
/** Caldari, Minmatar, Amarr, Gallente — "empire shipbuilding". */
export const EMPIRE_RACES: ReadonlySet<number> = new Set([1, 2, 4, 8]);
export const META = { t1: 1, t2: 2, t3: 14 } as const;
const CATEGORY = { material: 4, ship: 6, module: 7, commodity: 17, subsystem: 32 } as const;

/** Intermediates (components, R.A.M., fuel blocks, reaction products) — not end products. */
export const isIntermediate = (t: SdeType) => t.categoryId === CATEGORY.commodity || t.categoryId === CATEGORY.material;

export const CATEGORIES: { key: CategoryKey; label: string }[] = [
  { key: "mine", label: "Мои чертежи" },
  { key: "caldari_t1", label: "Калдари T1" },
  { key: "caldari_t2", label: "Калдари T2" },
  { key: "t3", label: "T3" },
  { key: "components", label: "Компоненты" },
  { key: "other", label: "Прочие" },
  { key: "reactions", label: "Реакции" },
  { key: "rigs_t1", label: "Риги T1" },
  { key: "rigs_t2", label: "Риги T2" },
  { key: "warp_disruptors", label: "Mobile Warp Disruptor" },
];

/** SDE group of the six deployable warp disruption bubbles (Small/Medium/Large, I and II). */
export const MOBILE_WARP_DISRUPTOR_GROUP = "Mobile Warp Disruptor";

/**
 * Not Caldari, but Nick builds them too: shown in the Caldari tabs and planned with the Caldari
 * hulls so they are not forgotten.
 */
export const CALDARI_BRANCH_EXTRA: ReadonlySet<string> = new Set(["Obelisk", "Anshar"]);

/** Caldari hull, or one of the extras Nick keeps in the Caldari branch. */
export const isCaldariBranchShip = (t: SdeType) => t.categoryId === CATEGORY.ship && (t.raceId === RACE_CALDARI || CALDARI_BRANCH_EXTRA.has(t.name));

/** Capital ship groups: too big for courier contracts, so no freight to market. */
const CAPITAL_GROUPS: ReadonlySet<string> = new Set([
  "Freighter",
  "Jump Freighter",
  "Carrier",
  "Supercarrier",
  "Dreadnought",
  "Lancer Dreadnought",
  "Force Auxiliary",
  "Titan",
  "Capital Industrial Ship",
]);
export const isCapital = (sde: SdeSource, t: SdeType | undefined) => !!t && t.categoryId === CATEGORY.ship && CAPITAL_GROUPS.has(sde.getGroup(t.groupId)?.name ?? "");

/** T1 items usually carry no meta group in the SDE. */
const isMeta = (t: SdeType, meta: number) => (meta === META.t1 ? t.metaGroupId == null || t.metaGroupId === META.t1 : t.metaGroupId === meta);

export function listCategory(sde: SdeSource, key: CategoryKey, ownedBlueprintIds: number[] = []): SdeType[] {
  if (key === "reactions") return sde.listProducts("reaction");
  if (key === "mine") {
    const out = new Map<number, SdeType>();
    for (const bpId of ownedBlueprintIds) {
      const bp = sde.getBlueprint(bpId);
      const productId = bp?.activities.manufacturing?.products[0]?.typeId ?? bp?.activities.reaction?.products[0]?.typeId;
      const t = productId ? sde.getType(productId) : undefined;
      // End products only; intermediates live in "Компоненты" / "Реакции".
      if (t?.published && !isIntermediate(t)) out.set(t.typeId, t);
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  const made = sde.listProducts("manufacturing");
  const groupName = (t: SdeType) => sde.getGroup(t.groupId)?.name ?? "";
  const isRig = (t: SdeType) => t.categoryId === CATEGORY.module && groupName(t).startsWith("Rig ");
  switch (key as Exclude<CategoryKey, "mine" | "reactions">) {
    case "components": {
      const forShips = shipInputs(sde);
      return made.filter((t) => t.categoryId === CATEGORY.commodity && forShips.has(t.typeId));
    }
    case "other": {
      const forShips = shipInputs(sde);
      return made.filter((t) => t.categoryId === CATEGORY.commodity && !forShips.has(t.typeId));
    }
    case "caldari_t1":
      return made.filter((t) => isCaldariBranchShip(t) && isMeta(t, META.t1));
    case "caldari_t2":
      return made.filter((t) => isCaldariBranchShip(t) && isMeta(t, META.t2));
    case "t3":
      return made.filter((t) => (t.categoryId === CATEGORY.ship && isMeta(t, META.t3)) || t.categoryId === CATEGORY.subsystem);
    case "rigs_t1":
      return made.filter((t) => isRig(t) && isMeta(t, META.t1));
    case "rigs_t2":
      return made.filter((t) => isRig(t) && isMeta(t, META.t2));
    case "warp_disruptors":
      // T1 and T2 only: the Syndicate versions are LP-store BPCs, not something Nick can build in bulk.
      return made.filter((t) => groupName(t) === MOBILE_WARP_DISRUPTOR_GROUP && (isMeta(t, META.t1) || isMeta(t, META.t2)));
  }
}

/** Why a category might come back empty — shown in the UI instead of a blank table. */
export function categoryHint(sde: SdeSource & { hasRaces?: () => boolean }, key: CategoryKey, hasCharacters = true): string | null {
  if (key === "mine" && !hasCharacters) return "Добавь персонажей на странице «Персонажи» — здесь появятся предметы по твоим чертежам";
  if ((key === "caldari_t1" || key === "caldari_t2") && sde.hasRaces && !sde.hasRaces()) {
    return "В SDE нет рас — пересобери базу: npm run sde:download -- --force";
  }
  return null;
}

/**
 * Every type that goes, at any depth, into a ship of the four empire races. Components outside
 * this set (mutaplasmid-like items, structure and deployable parts, …) go to «Прочие».
 */
const shipInputsCache = new WeakMap<SdeSource, Map<string, Set<number>>>();
export function shipInputs(sde: SdeSource, races: ReadonlySet<number> = EMPIRE_RACES): Set<number> {
  const key = [...races].sort().join(",");
  const byRaces = shipInputsCache.get(sde) ?? new Map<string, Set<number>>();
  shipInputsCache.set(sde, byRaces);
  const hit = byRaces.get(key);
  if (hit) return hit;
  const recipe = recipeLookup(sde);
  const out = new Set<number>();
  const stack = sde
    .listProducts("manufacturing")
    .filter((t) => t.categoryId === CATEGORY.ship && t.raceId != null && races.has(t.raceId))
    .map((t) => t.typeId);
  const seen = new Set<number>();
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const m of recipe(id)?.materials ?? []) {
      out.add(m.typeId);
      stack.push(m.typeId);
    }
  }
  byRaces.set(key, out);
  return out;
}

/** SDE raceID of Triglavian and EDENCOM items (ships, modules, ammo). */
export const RACE_TRIGLAVIAN = 135;
export const RACE_EDENCOM = 168;

export type Blacklist = { boosters: boolean; triglavian: boolean; edencom: boolean; typeIds: number[] };

/** Why an item is blacklisted (null = it is not). */
export function blacklistReason(sde: SdeSource, t: SdeType, bl: Blacklist): string | null {
  if (bl.typeIds.includes(t.typeId)) return "в блэклисте";
  const group = sde.getGroup(t.groupId)?.name ?? "";
  // Boosters and their reaction intermediates (gas from null/WH only).
  if (bl.boosters && (group === "Booster" || group === "Biochemical Material")) return "бустеры";
  if (bl.triglavian && t.raceId === RACE_TRIGLAVIAN) return "триглавское";
  if (bl.edencom && (t.raceId === RACE_EDENCOM || group.startsWith("Vorton Projector"))) return "EDENCOM";
  return null;
}
