/** Assembles engine inputs from SDE + settings + profiles + prices and returns a UI-ready result. */
import { normalizeRigs, type FacilityProfile } from "@/engine/facility";
import { inventionCost, type InventionResult } from "@/engine/invention";
import { jobTime } from "@/engine/jobCost";
import type { PriceMode } from "@/engine/pricing";
import { summarizeProfit, type ProfitSummary } from "@/engine/profit";
import { materialFlags, realisticPrice, type SanityFlag } from "@/engine/marketSanity";
import { buildTree, type Decision, type TreeJob } from "@/engine/tree";
import type { Activity } from "@/engine/types";
import { recipeLookup } from "@/sde/recipes";
import type { SdeSource } from "@/sde/types";
import { SKILL_IDS } from "@/engine/bonuses";
import type { IndustrySkills } from "@/engine/jobCost";
import type { InventionSkills } from "@/engine/invention";
import type { BlueprintActivity } from "@/engine/types";
import { isCapital } from "./catalog";
import { hasCharacters, ownedBlueprintIndex, skillLevels, type OwnedBlueprint } from "./characters";
import { costIndicesFor, getProfile, getSde, getSettings, historyFor, listProfiles, priceBook, type Profile } from "./data";

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
  /** Plan only: what an hour of a factory/reaction slot earns on hulls; cheaper-to-build intermediates that save less are bought. */
  slotIskPerHour?: Partial<Record<Activity, number>>;
  /** Invention decryptor type id; null = none; undefined = from settings. */
  decryptorId?: number | null;
  /** Also compute profit for every decryptor (calculator only — costs one tree per decryptor). */
  compareDecryptors?: boolean;
}

export interface DecryptorComparison {
  decryptorId: number | null;
  name: string;
  me: number;
  te: number;
  runsPerSuccess: number;
  chance: number;
  costPerRun: number;
  /** Profit of the same batch with this decryptor (null = no product price). */
  profit: number | null;
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
  /** Bought materials: not on sale, or far above market history (price is not replaced). */
  priceFlags: SanityFlag[];
  activity: Activity | null;
  job: (Omit<TreeJob, "cost"> & { cost: number; costBreakdown: TreeJob["cost"] }) | null;
  children: { typeId: number; quantity: number; baseQuantity?: number }[];
}

export interface InventionOption extends InventionResult {
  sourceId: number;
  sourceName: string;
  /** T1 blueprint source: lab time to copy one run of it (null for relics). */
  copySecondsPerRun: number | null;
}

export interface CalcResponse {
  request: Required<Pick<CalcRequest, "typeId" | "runs" | "me" | "te" | "blueprintSource" | "materialPriceMode" | "productPriceMode">>;
  product: { typeId: number; name: string };
  summary: ProfitSummary;
  nodes: NodeDTO[];
  jobs: (NodeDTO["job"] & { name: string })[];
  shopping: { typeId: number; name: string; quantity: number; unitPrice: number | null; cost: number | null; freight: number; volume: number; priceFlags: SanityFlag[] }[];
  invention: {
    options: InventionOption[];
    chosen: InventionOption | null;
    decryptor: { typeId: number; name: string } | null;
    /** Filled when compareDecryptors was asked and the root is invented. */
    comparison: DecryptorComparison[];
  };
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
  const timeBonusPerLevel = sde.skillTimeBonuses() ?? undefined;
  const skills: IndustrySkills = levels
    ? {
        industry: levels.get(SKILL_IDS.industry) ?? 0,
        advancedIndustry: levels.get(SKILL_IDS.advancedIndustry) ?? 0,
        reactions: levels.get(SKILL_IDS.reactions) ?? 0,
        levels: Object.fromEntries(levels),
        timeBonusPerLevel,
      }
    : { ...s.industrySkills, timeBonusPerLevel };
  const owned = withChars ? ownedBlueprintIndex() : new Map<number, OwnedBlueprint>();
  const ownedRoot = owned.get(rootRecipe.blueprintTypeId) ?? null;

  // Invention options for the root blueprint.
  const sources = sde.findProducers(rootRecipe.blueprintTypeId, "invention");
  const blueprintSource = req.blueprintSource ?? (ownedRoot ? "owned" : sources.length ? "invention" : "owned");
  const materialPriceMode = req.materialPriceMode ?? s.materialPriceMode;
  const productPriceMode = req.productPriceMode ?? s.productPriceMode;
  const fees = { salesTax: s.salesTax, brokerFee: s.brokerFee };

  // Price book over every type the tree or invention might touch.
  const touched = touchedTypes(sde, recipe, req.typeId);
  const prices = priceBook(touched, s.priceLocationId);
  const history = historyFor(touched, s.priceRegionId);
  // The product's sale price, capped by market history (one rule for every page).
  const sale = realisticPrice(prices.quote(req.typeId), history.get(req.typeId), productPriceMode, s.marketSanity);
  const flagsOf = (id: number) => materialFlags(prices.quote(id), history.get(id), materialPriceMode, s.marketSanity);

  const decryptors = sde.listDecryptors();
  const wantedDecryptor = req.decryptorId === undefined ? s.inventionDecryptorId : req.decryptorId;
  const decryptor = wantedDecryptor === null ? null : decryptors.find((d) => d.typeId === wantedDecryptor) ?? null;
  if (wantedDecryptor !== null && !decryptor) warnings.push("Декриптор не найден в SDE — пересобери базу (npm run sde:download -- --force)");

  const inventFrom = (src: { blueprintTypeId: number }, d: typeof decryptor): InventionOption | null => {
    const inv = sde.getBlueprint(src.blueprintTypeId)?.activities.invention;
    if (!inv) return null;
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
      decryptor: d,
      timeSkills: skills,
    });
    const copying = isBlueprint ? sde.getBlueprint(src.blueprintTypeId)?.activities.copying : undefined;
    const copySecondsPerRun = copying ? jobTime(copying.time, 1, 0, "copying", toFacility(mfgProfile), skills) : null;
    return { ...r, sourceId: src.blueprintTypeId, sourceName: name(src.blueprintTypeId), copySecondsPerRun };
  };
  const options = sources.map((src) => inventFrom(src, decryptor)).filter((o): o is InventionOption => !!o);
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

  const volumeOf = (id: number) => {
    const t = sde.getType(id);
    return t ? t.packagedVolume ?? t.volume : 0;
  };
  // Capitals do not go by courier: you fly or sell them where they are built.
  const productFreight = isCapital(sde, sde.getType(req.typeId)) ? 0 : volumeOf(req.typeId) * s.freightOutPerM3;
  const treeFor = (rootMe: number, rootTe: number) => buildTree(req.typeId, req.runs, {
    recipe,
    freight: s.freightInPerM3 > 0 ? { perM3: s.freightInPerM3, volume: volumeOf } : undefined,
    blueprintLevels: (bp) => {
      if (bp === rootRecipe.blueprintTypeId) return { me: rootMe, te: rootTe };
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
    slotIskPerHour: req.slotIskPerHour,
  });
  const tree = treeFor(me, te);
  warnings.push(...tree.warnings.map((w) => localizeWarning(w, name)));

  // Own BPC valued at the cost of inventing it (setting), so they compete fairly with invented ones.
  let bpcValue = 0;
  if (!chosen && ownedRoot && !ownedRoot.isBpo && s.ownBpcValue === "invention") {
    const cheapest = [...options].sort((a, b) => a.costPerRun - b.costPerRun)[0];
    if (cheapest) bpcValue = cheapest.costPerRun;
    else warnings.push("Свой BPC: инвента нет, стоимость чертежа не учтена");
  }
  const blueprintPerRun = chosen?.costPerRun ?? bpcValue;
  const summary = summarizeProfit(tree, sale, productPriceMode, fees, blueprintPerRun, productFreight);
  const oddMaterials = tree.shopping.filter((l) => flagsOf(l.typeId).length).map((l) => `${name(l.typeId)} — ${flagsOf(l.typeId).map((f) => f.label).join(", ")}`);
  if (oddMaterials.length) warnings.push(`Проверь цены материалов: ${oddMaterials.join("; ")}`);

  // Same batch with every decryptor (and none), each with its own ME/TE → full tree.
  const comparison: DecryptorComparison[] = [];
  if (req.compareDecryptors && chosen) {
    const src = { blueprintTypeId: chosen.sourceId };
    for (const d of [null, ...decryptors]) {
      const o = inventFrom(src, d);
      if (!o) continue;
      const t = treeFor(o.me, o.te);
      const p = summarizeProfit(t, sale, productPriceMode, fees, o.costPerRun, productFreight);
      comparison.push({
        decryptorId: d?.typeId ?? null,
        name: d?.name ?? "Без декриптора",
        me: o.me,
        te: o.te,
        runsPerSuccess: o.runsPerSuccess,
        chance: o.chance,
        costPerRun: o.costPerRun,
        profit: p.profit,
      });
    }
  }

  const nodes: NodeDTO[] = [...tree.nodes.values()].map((n) => ({
    typeId: n.typeId,
    name: name(n.typeId),
    decision: n.decision,
    reason: n.reason,
    demand: n.demand,
    buyUnitCost: n.buyUnitCost,
    buildUnitCost: n.buildUnitCost,
    buildSavingsPerHour: n.buildSavingsPerHour,
    priceFlags: n.decision === "buy" ? flagsOf(n.typeId) : [],
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
    shopping: tree.shopping.map((l) => ({ ...l, name: name(l.typeId), volume: volumeOf(l.typeId) * l.quantity, priceFlags: flagsOf(l.typeId) })),
    invention: { options, chosen, decryptor: decryptor && { typeId: decryptor.typeId, name: decryptor.name }, comparison },
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
  if (rootBp && sde.findProducers(rootBp, "invention").length) for (const d of sde.listDecryptors()) out.add(d.typeId);
  return [...out];
}

/** Market type ids the calculation for `typeId` reads prices for (used by "refresh prices"). */
export function priceTypesFor(typeId: number): number[] {
  const { source: sde } = getSde();
  return touchedTypes(sde, recipeLookup(sde), typeId).filter((id) => sde.getType(id)?.marketGroupId != null);
}
