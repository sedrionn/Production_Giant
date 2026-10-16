/** Assembles engine inputs from SDE + settings + profiles + prices and returns a UI-ready result. */
import { normalizeRigs, type FacilityProfile } from "@/engine/facility";
import { inventionCost, type InventionResult } from "@/engine/invention";
import type { PriceMode } from "@/engine/pricing";
import { summarizeProfit, type ProfitSummary } from "@/engine/profit";
import { buildTree, type Decision, type TreeJob } from "@/engine/tree";
import type { Activity } from "@/engine/types";
import { recipeLookup } from "@/sde/recipes";
import type { SdeSource } from "@/sde/types";
import { SKILL_IDS } from "@/engine/bonuses";
import type { IndustrySkills } from "@/engine/jobCost";
import type { InventionSkills } from "@/engine/invention";
import type { BlueprintActivity } from "@/engine/types";
import { hasCharacters, ownedBlueprintIndex, skillLevels, type OwnedBlueprint } from "./characters";
import { costIndicesFor, getProfile, getSde, getSettings, listProfiles, priceBook, type Profile } from "./data";

export interface CalcRequest {
  typeId: number;
  runs: number;
  me?: number;
  te?: number;
  /** "owned": you have the BPO/BPC; "invention": BPC cost is added per run. */
  blueprintSource?: "owned" | "invention";
  /** Relic / T1 blueprint to invent from; cheapest per run when omitted. */
  inventionSourceId?: number;
  decisions?: Record<number, Decision>;
  materialPriceMode?: PriceMode;
  productPriceMode?: PriceMode;
  manufacturingProfileId?: number;
  reactionProfileId?: number;
  minBuildIskPerHour?: number;
}

export interface NodeDTO {
  typeId: number;
  name: string;
  decision: Decision;
  reason: string;
  demand: number;
  buyUnitCost: number | null;
  buildUnitCost: number | null;
  buildSavingsPerHour: number | null;
  activity: Activity | null;
  job: (Omit<TreeJob, "cost"> & { cost: number; costBreakdown: TreeJob["cost"] }) | null;
  children: { typeId: number; quantity: number }[];
}

export interface InventionOption extends InventionResult {
  sourceId: number;
  sourceName: string;
}

export interface CalcResponse {
  request: Required<Pick<CalcRequest, "typeId" | "runs" | "me" | "te" | "blueprintSource" | "materialPriceMode" | "productPriceMode">>;
  product: { typeId: number; name: string };
  summary: ProfitSummary;
  nodes: NodeDTO[];
  jobs: (NodeDTO["job"] & { name: string })[];
  shopping: { typeId: number; name: string; quantity: number; unitPrice: number | null; cost: number | null; volume: number }[];
  invention: { options: InventionOption[]; chosen: InventionOption | null };
  /** Best owned blueprint for the product (null if none or no characters). */
  ownedBlueprint: OwnedBlueprint | null;
  /** "characters" when skills come from synced characters, otherwise "settings". */
  skillsSource: "characters" | "settings";
  facilities: { manufacturing: ProfileDTO | null; reaction: ProfileDTO | null; costIndexSource: string };
  prices: ReturnType<ReturnType<typeof priceBook>["meta"]>;
  sde: { kind: "sqlite" | "fixtures"; build: string | null };
  warnings: string[];
}

export interface ProfileDTO {
  id: number;
  name: string;
  structureType: string;
  security: string;
  systemId: number | null;
  systemName: string | null;
  costIndices: Partial<Record<Activity, number>>;
}

const NPC_FALLBACK: FacilityProfile = { structure: "npc_station", security: "high", rigs: [], facilityTax: 0.0025 };

function toFacility(p: Profile | undefined): FacilityProfile {
  if (!p) return NPC_FALLBACK;
  return {
    structure: p.structureType,
    security: p.security,
    rigs: normalizeRigs(p.rigs),
    facilityTax: p.facilityTax,
    systemJobBonus: p.systemJobBonus,
  };
}

export function calculate(req: CalcRequest): CalcResponse {
  const { source: sde, kind, build } = getSde();
  const s = getSettings();
  const warnings: string[] = [];
  const name = (id: number) => sde.getType(id)?.name ?? `#${id}`;

  const profiles = listProfiles();
  const mfgProfile =
    getProfile(req.manufacturingProfileId ?? s.manufacturingProfileId) ?? profiles.find((p) => p.isDefault && p.structureType !== "athanor" && p.structureType !== "tatara");
  const rxProfile =
    getProfile(req.reactionProfileId ?? s.reactionProfileId) ?? profiles.find((p) => p.structureType === "tatara" || p.structureType === "athanor");
  if (!mfgProfile) warnings.push("Нет пресета для производства — считаю как NPC-станцию");
  if (!rxProfile) warnings.push("Нет пресета для реакций — считаю как NPC-станцию (в игре так нельзя)");

  const mfgIdx = costIndicesFor(mfgProfile?.solarSystemId);
  const rxIdx = costIndicesFor(rxProfile?.solarSystemId);
  if (mfgIdx.source === "none") warnings.push("У пресета производства не указана система (или нет cost index) — стоимость джоб = только налоги");

  const recipe = recipeLookup(sde);
  const rootRecipe = recipe(req.typeId);
  if (!rootRecipe) throw new Error(`${name(req.typeId)} нельзя построить`);

  // Characters: real skills and owned blueprints when synced, settings otherwise.
  const withChars = hasCharacters();
  const levels = withChars ? skillLevels(s.industryCharacterId) : null;
  const skills: IndustrySkills = levels
    ? {
        industry: levels.get(SKILL_IDS.industry) ?? 0,
        advancedIndustry: levels.get(SKILL_IDS.advancedIndustry) ?? 0,
        reactions: levels.get(SKILL_IDS.reactions) ?? 0,
        levels: Object.fromEntries(levels),
      }
    : s.industrySkills;
  const owned = withChars ? ownedBlueprintIndex() : new Map<number, OwnedBlueprint>();
  const ownedRoot = owned.get(rootRecipe.blueprintTypeId) ?? null;

  // Invention options for the root blueprint.
  const sources = sde.findProducers(rootRecipe.blueprintTypeId, "invention");
  const blueprintSource = req.blueprintSource ?? (ownedRoot ? "owned" : sources.length ? "invention" : "owned");
  const materialPriceMode = req.materialPriceMode ?? s.materialPriceMode;
  const productPriceMode = req.productPriceMode ?? s.productPriceMode;
  const fees = { salesTax: s.salesTax, brokerFee: s.brokerFee };

  // Price book over every type the tree or invention might touch.
  const prices = priceBook(touchedTypes(sde, recipe, req.typeId), s.priceLocationId);

  const options: InventionOption[] = sources.flatMap((src) => {
    const inv = sde.getBlueprint(src.blueprintTypeId)?.activities.invention;
    if (!inv) return [];
    const isBlueprint = sde.getType(src.blueprintTypeId)?.name.endsWith("Blueprint") ?? false;
    // T1 blueprint copies come from your own BPO (copy cost not modelled); relics are consumed and bought.
    const relicPrice = isBlueprint ? 0 : prices.quote(src.blueprintTypeId)?.sellMin ?? null;
    if (relicPrice === null) warnings.push(`Нет цены на ${name(src.blueprintTypeId)}`);
    const r = inventionCost({
      invention: inv,
      targetBlueprintTypeId: rootRecipe.blueprintTypeId,
      targetManufacturing: rootRecipe,
      skills: inventionSkillsFor(inv, levels, s.inventionSkills, (id) => sde.getType(id)?.name ?? ""),
      sourceItemCost: relicPrice ?? 0,
      quote: prices.quote,
      adjustedPrice: prices.adjusted,
      materialPriceMode,
      fees,
      facility: toFacility(mfgProfile),
      costIndex: mfgIdx.indices.invention ?? 0,
    });
    return [{ ...r, sourceId: src.blueprintTypeId, sourceName: name(src.blueprintTypeId) }];
  });
  const chosen =
    blueprintSource === "invention"
      ? options.find((o) => o.sourceId === req.inventionSourceId) ??
        [...options].sort((a, b) => a.costPerRun - b.costPerRun)[0] ??
        null
      : null;
  if (blueprintSource === "invention" && !chosen) warnings.push("Для этого чертежа нет инвента — считаю как свой BPO");
  const usesOwned = !chosen;
  if (usesOwned && withChars && !ownedRoot) warnings.push("У персонажей нет этого чертежа — ME/TE взяты из настроек");

  const me = req.me ?? (chosen ? chosen.me : ownedRoot ? ownedRoot.me : s.defaultMe);
  const te = req.te ?? (chosen ? chosen.te : ownedRoot ? ownedRoot.te : s.defaultTe);

  const tree = buildTree(req.typeId, req.runs, {
    recipe,
    blueprintLevels: (bp) => {
      if (bp === rootRecipe.blueprintTypeId) return { me, te };
      const o = owned.get(bp);
      return o ? { me: o.me, te: o.te } : { me: s.defaultMe, te: s.defaultTe };
    },
    facility: (a) => toFacility(a === "reaction" ? rxProfile : mfgProfile),
    itemClass: (id) => {
      const t = sde.getType(id);
      return t && { categoryId: t.categoryId, groupId: t.groupId };
    },
    costIndex: (a) => (a === "reaction" ? rxIdx.indices.reaction : mfgIdx.indices[a]) ?? 0,
    quote: prices.quote,
    adjustedPrice: prices.adjusted,
    materialPriceMode,
    fees,
    skills,
    decisions: req.decisions,
    minBuildIskPerHour: req.minBuildIskPerHour ?? s.minBuildIskPerHour,
  });
  warnings.push(...tree.warnings.map((w) => localizeWarning(w, name)));

  const summary = summarizeProfit(tree, prices.quote(req.typeId), productPriceMode, fees, chosen?.costPerRun ?? 0);

  const nodes: NodeDTO[] = [...tree.nodes.values()].map((n) => ({
    typeId: n.typeId,
    name: name(n.typeId),
    decision: n.decision,
    reason: n.reason,
    demand: n.demand,
    buyUnitCost: n.buyUnitCost,
    buildUnitCost: n.buildUnitCost,
    buildSavingsPerHour: n.buildSavingsPerHour,
    activity: recipe(n.typeId)?.activity ?? null,
    job: n.job ? { ...n.job, cost: n.job.cost.total, costBreakdown: n.job.cost } : null,
    children: n.children,
  }));

  const dto = (p: Profile | undefined, idx: ReturnType<typeof costIndicesFor>): ProfileDTO | null =>
    p
      ? {
          id: p.id,
          name: p.name,
          structureType: p.structureType,
          security: p.security,
          systemId: p.solarSystemId,
          systemName: p.solarSystemId ? sde.getSystem(p.solarSystemId)?.name ?? null : null,
          costIndices: idx.indices,
        }
      : null;

  return {
    request: { typeId: req.typeId, runs: req.runs, me, te, blueprintSource: chosen ? "invention" : "owned", materialPriceMode, productPriceMode },
    product: { typeId: req.typeId, name: name(req.typeId) },
    summary,
    nodes,
    jobs: tree.jobs.map((j) => ({ ...j, cost: j.cost.total, costBreakdown: j.cost, name: name(j.typeId) })),
    shopping: tree.shopping.map((l) => ({ ...l, name: name(l.typeId), volume: (sde.getType(l.typeId)?.volume ?? 0) * l.quantity })),
    invention: { options, chosen },
    ownedBlueprint: ownedRoot,
    skillsSource: levels ? "characters" : "settings",
    facilities: { manufacturing: dto(mfgProfile, mfgIdx), reaction: dto(rxProfile, rxIdx), costIndexSource: mfgIdx.source },
    prices: prices.meta(),
    sde: { kind, build },
    warnings: [...new Set(warnings)],
  };
}

/**
 * Invention skills from the activity's required skills: the "Encryption Methods" one counts /40,
 * the two science skills /30. With characters, real levels; otherwise the settings.
 */
function inventionSkillsFor(
  inv: BlueprintActivity,
  levels: Map<number, number> | null,
  fallback: InventionSkills,
  skillName: (id: number) => string,
): InventionSkills {
  if (!levels) return fallback;
  const enc = inv.skills.find((sk) => skillName(sk.typeId).includes("Encryption"));
  const sci = inv.skills.filter((sk) => sk !== enc);
  return {
    encryption: enc ? levels.get(enc.typeId) ?? 0 : 0,
    science1: sci[0] ? levels.get(sci[0].typeId) ?? 0 : 0,
    science2: sci[1] ? levels.get(sci[1].typeId) ?? 0 : 0,
  };
}

function localizeWarning(w: string, name: (id: number) => string): string {
  return w
    .replace(/\b(\d{2,})\b/g, (m) => name(Number(m)))
    .replace("no adjusted price for", "нет adjusted price для")
    .replace("job cost of", "стоимость джобы")
    .replace("no market price for", "нет рыночной цены для")
    .replace("total cost understated", "итог занижен")
    .replace("understated", "занижена");
}

/** Every type the tree (all levels) and the root's invention can read. */
function touchedTypes(sde: SdeSource, recipe: ReturnType<typeof recipeLookup>, typeId: number): number[] {
  const out = new Set<number>([typeId]);
  const stack = [typeId];
  while (stack.length) {
    const r = recipe(stack.pop()!);
    for (const m of r?.materials ?? []) {
      if (out.has(m.typeId)) continue;
      out.add(m.typeId);
      stack.push(m.typeId);
    }
  }
  const rootBp = recipe(typeId)?.blueprintTypeId;
  for (const src of rootBp ? sde.findProducers(rootBp, "invention") : []) {
    out.add(src.blueprintTypeId);
    for (const m of sde.getBlueprint(src.blueprintTypeId)?.activities.invention?.materials ?? []) out.add(m.typeId);
  }
  return [...out];
}

/** Market type ids the calculation for `typeId` reads prices for (used by "refresh prices"). */
export function priceTypesFor(typeId: number): number[] {
  const { source: sde } = getSde();
  return touchedTypes(sde, recipeLookup(sde), typeId).filter((id) => sde.getType(id)?.marketGroupId != null);
}
