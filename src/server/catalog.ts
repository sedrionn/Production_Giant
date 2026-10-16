/**
 * Item lists for the profitability overview. Each category is a filter over SDE
 * products; "mine" (owned blueprints) is added on top when characters are synced.
 */
import type { SdeSource, SdeType } from "@/sde/types";

export type CategoryKey = "caldari_t1" | "caldari_t2" | "t3" | "reactions" | "rigs_t1" | "rigs_t2";

export const RACE_CALDARI = 1;
export const META = { t1: 1, t2: 2, t3: 14 } as const;
const CATEGORY = { ship: 6, module: 7, subsystem: 32 } as const;

export const CATEGORIES: { key: CategoryKey; label: string }[] = [
  { key: "caldari_t1", label: "Калдари T1" },
  { key: "caldari_t2", label: "Калдари T2" },
  { key: "t3", label: "T3" },
  { key: "reactions", label: "Реакции" },
  { key: "rigs_t1", label: "Риги T1" },
  { key: "rigs_t2", label: "Риги T2" },
];

/** T1 items usually carry no meta group in the SDE. */
const isMeta = (t: SdeType, meta: number) => (meta === META.t1 ? t.metaGroupId == null || t.metaGroupId === META.t1 : t.metaGroupId === meta);

export function listCategory(sde: SdeSource, key: CategoryKey): SdeType[] {
  if (key === "reactions") return sde.listProducts("reaction");
  const made = sde.listProducts("manufacturing");
  const groupName = (t: SdeType) => sde.getGroup(t.groupId)?.name ?? "";
  const isRig = (t: SdeType) => t.categoryId === CATEGORY.module && groupName(t).startsWith("Rig ");
  switch (key) {
    case "caldari_t1":
      return made.filter((t) => t.categoryId === CATEGORY.ship && t.raceId === RACE_CALDARI && isMeta(t, META.t1));
    case "caldari_t2":
      return made.filter((t) => t.categoryId === CATEGORY.ship && t.raceId === RACE_CALDARI && isMeta(t, META.t2));
    case "t3":
      return made.filter((t) => (t.categoryId === CATEGORY.ship && isMeta(t, META.t3)) || t.categoryId === CATEGORY.subsystem);
    case "rigs_t1":
      return made.filter((t) => isRig(t) && isMeta(t, META.t1));
    case "rigs_t2":
      return made.filter((t) => isRig(t) && isMeta(t, META.t2));
  }
}

/** Why a category might come back empty — shown in the UI instead of a blank table. */
export function categoryHint(sde: SdeSource & { hasRaces?: () => boolean }, key: CategoryKey): string | null {
  if ((key === "caldari_t1" || key === "caldari_t2") && sde.hasRaces && !sde.hasRaces()) {
    return "В SDE нет рас — пересобери базу: npm run sde:download -- --force";
  }
  return null;
}
