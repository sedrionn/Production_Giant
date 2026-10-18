/**
 * Full build tree: what to build, what to buy, how many runs, what it costs.
 *
 * Three passes:
 *  1. discover   — walk recipes from the root, find cycles.
 *  2. decide     — bottom-up unit costs; per node build vs buy (cheaper wins,
 *                  unless overridden). Uses un-rounded per-unit material use,
 *                  good enough for the decision.
 *  3. aggregate  — top-down in topological order: total demand per type across
 *                  the whole tree → runs = ceil(demand / output per run) with real
 *                  ME rounding per job → demand on inputs. Shared intermediates
 *                  (e.g. Fulleroferrocene used by 4 components) become ONE job.
 */
import { materialMultiplier, type FacilityProfile, type ItemClass } from "./facility";
import { estimatedItemValue, jobInstallCost, jobTime, type IndustrySkills, type JobCostBreakdown } from "./jobCost";
import { materialsForJob } from "./materials";
import { acquisitionFeeRate, quotePrice, type FeeRates, type MarketQuote, type PriceMode } from "./pricing";
import type { Activity, BlueprintActivity } from "./types";

export type Decision = "build" | "buy";

export interface TreeContext {
  /** Manufacturing or reaction recipe that produces `typeId`, if any. */
  recipe(typeId: number): BlueprintActivity | undefined;
  /** ME/TE for the blueprint (owned BPO/BPC levels, or defaults). */
  blueprintLevels(blueprintTypeId: number, activity: Activity): { me: number; te: number };
  facility(activity: Activity): FacilityProfile;
  /** Category/group of a type — decides which rigs apply. Optional: without it only "all" rigs apply. */
  itemClass?(typeId: number): ItemClass | undefined;
  costIndex(activity: Activity): number;
  quote(typeId: number): MarketQuote | undefined;
  adjustedPrice(typeId: number): number | undefined;
  materialPriceMode: PriceMode;
  fees: FeeRates;
  skills?: IndustrySkills;
  /** Manual overrides per type. */
  decisions?: Record<number, Decision>;
  /**
   * Build an intermediate only if it saves at least this much ISK per hour of its own
   * job time vs buying it. 0/undefined = build whenever cheaper. Root is always built.
   */
  minBuildIskPerHour?: number;
  /**
   * Freight for bought materials (market → factory): ISK per m³ × the item's (packaged) volume,
   * added to the buy price of every purchased unit. Omitted = no freight.
   */
  freight?: { perM3: number; volume(typeId: number): number };
}

export interface TreeEdge {
  typeId: number;
  /** Quantity this parent's (aggregated) job consumes. */
  quantity: number;
  /** Blueprint quantity per run before ME and facility bonuses (to recompute for other run counts). */
  baseQuantity?: number;
}

export interface TreeNode {
  typeId: number;
  decision: Decision;
  /** Why: "override", "cheaper", "no recipe", "no market price", "root", "cycle". */
  reason: string;
  /** Total units needed across the tree. */
  demand: number;
  /** Market unit price incl. acquisition fee (null = no market). */
  buyUnitCost: number | null;
  /** Estimated unit cost if built with the chosen sub-decisions (null = cannot build or unpriced inputs). */
  buildUnitCost: number | null;
  /** (buy − build) per hour of this node's own job time; null when not comparable. */
  buildSavingsPerHour: number | null;
  /** Present when built. */
  job?: TreeJob;
  /** Inputs of this node's job (only when built). */
  children: TreeEdge[];
}

export interface TreeJob {
  typeId: number;
  blueprintTypeId: number;
  activity: Activity;
  me: number;
  te: number;
  runs: number;
  outputPerRun: number;
  output: number;
  surplus: number;
  cost: JobCostBreakdown;
  timeSeconds: number;
  /** Facility material multiplier used for this job (structure × rigs). */
  materialMultiplier: number;
}

export interface ShoppingLine {
  typeId: number;
  quantity: number;
  unitPrice: number | null;
  /** quantity × unit price × (1 + acquisition fee); null when unpriced. */
  cost: number | null;
  /** quantity × volume × freight rate (0 without freight). */
  freight: number;
}

export interface TreeResult {
  rootTypeId: number;
  rootRuns: number;
  nodes: Map<number, TreeNode>;
  /** Jobs in build order (inputs first). */
  jobs: TreeJob[];
  shopping: ShoppingLine[];
  materialCost: number;
  jobCost: number;
  /**
   * Value of intermediate surplus (whole-run leftovers, e.g. 40 fuel blocks when 5 are needed),
   * at its own unit cost (build cost, else market). It stays in stock for the next batch,
   * so it is not charged to this one. Same idea as EVE Guru's prorated sub-builds.
   */
  surplusCredit: number;
  /** Freight of all bought materials to the factory. */
  freightCost: number;
  /** materialCost + jobCost + freightCost − surplusCredit. */
  totalCost: number;
  /** Sum of the longest chain is not computed yet; this is the plain sum. */
  totalJobSeconds: number;
  output: number;
  warnings: string[];
}

interface Discovered {
  recipe?: BlueprintActivity;
  /** Children that would close a cycle — forced to buy. */
  cyclic: Set<number>;
}

export function buildTree(rootTypeId: number, rootRuns: number, ctx: TreeContext): TreeResult {
  if (!Number.isInteger(rootRuns) || rootRuns < 1) throw new RangeError(`runs must be a positive integer, got ${rootRuns}`);
  const warnings: string[] = [];
  const acqFee = acquisitionFeeRate(ctx.materialPriceMode, ctx.fees);
  const freightPerUnit = (t: number) => (ctx.freight ? ctx.freight.volume(t) * ctx.freight.perM3 : 0);

  // ---- 1. discover --------------------------------------------------------
  const info = new Map<number, Discovered>();
  const onStack = new Set<number>();
  const discover = (typeId: number) => {
    if (info.has(typeId)) return;
    const d: Discovered = { recipe: ctx.recipe(typeId), cyclic: new Set() };
    info.set(typeId, d);
    if (!d.recipe) return;
    onStack.add(typeId);
    for (const m of d.recipe.materials) {
      if (onStack.has(m.typeId)) d.cyclic.add(m.typeId);
      else discover(m.typeId);
    }
    onStack.delete(typeId);
  };
  discover(rootTypeId);
  const rootRecipe = info.get(rootTypeId)!.recipe;
  if (!rootRecipe) throw new Error(`no manufacturing or reaction recipe produces type ${rootTypeId}`);

  // ---- 2. decide (bottom-up, memoized) ------------------------------------
  const nodes = new Map<number, TreeNode>();
  const unitCost = new Map<number, number | null>();

  const levels = (r: BlueprintActivity) => {
    const l = ctx.blueprintLevels(r.blueprintTypeId, r.activity);
    return r.activity === "manufacturing" ? l : { me: 0, te: 0 };
  };

  const decide = (typeId: number, forcedBuy: boolean): number | null => {
    if (unitCost.has(typeId) && !forcedBuy) return unitCost.get(typeId)!;
    const d = info.get(typeId)!;
    const price = quotePrice(ctx.quote(typeId), ctx.materialPriceMode);
    const buyUnitCost = price === null ? null : price * (1 + acqFee) + freightPerUnit(typeId);

    let buildUnitCost: number | null = null;
    let hoursPerUnit: number | null = null;
    if (d.recipe && !forcedBuy) {
      const r = d.recipe;
      const { me } = levels(r);
      const mult = materialMultiplier(ctx.facility(r.activity), r.activity, ctx.itemClass?.(typeId));
      const perRunOut = r.products.find((p) => p.typeId === typeId)?.quantity ?? 1;
      let inputs = 0;
      let complete = true;
      for (const m of r.materials) {
        const c = decide(m.typeId, d.cyclic.has(m.typeId));
        if (c === null) complete = false;
        else inputs += m.quantity * (1 - me / 100) * mult * c;
      }
      const { eiv } = estimatedItemValue(r.materials, 1, ctx.adjustedPrice);
      const job = jobInstallCost(eiv, r.activity, ctx.costIndex(r.activity), ctx.facility(r.activity), ctx.itemClass?.(typeId)).total;
      buildUnitCost = complete ? (inputs + job) / perRunOut : null;
      const { te } = levels(r);
      const perRun = jobTime(r.time, 1, te, r.activity, ctx.facility(r.activity), ctx.skills, ctx.itemClass?.(typeId), r.skills);
      hoursPerUnit = perRun / 3600 / perRunOut;
    }
    const buildSavingsPerHour =
      buildUnitCost !== null && buyUnitCost !== null && hoursPerUnit ? (buyUnitCost - buildUnitCost) / hoursPerUnit : null;
    const minPerHour = ctx.minBuildIskPerHour ?? 0;

    const override = ctx.decisions?.[typeId];
    let decision: Decision;
    let reason: string;
    if (typeId === rootTypeId) [decision, reason] = ["build", "root"];
    else if (forcedBuy) [decision, reason] = ["buy", "cycle"];
    else if (!d.recipe) [decision, reason] = ["buy", "no recipe"];
    else if (override) [decision, reason] = [override, "override"];
    else if (buyUnitCost === null && buildUnitCost !== null) [decision, reason] = ["build", "no market price"];
    else if (buildUnitCost !== null && buyUnitCost !== null && buildUnitCost < buyUnitCost) {
      [decision, reason] = (buildSavingsPerHour ?? Infinity) >= minPerHour ? ["build", "cheaper"] : ["buy", "below threshold"];
    }
    else [decision, reason] = ["buy", buildUnitCost === null ? "build unpriced" : "cheaper"];

    const cost = decision === "build" ? buildUnitCost : buyUnitCost;
    if (!forcedBuy) {
      nodes.set(typeId, { typeId, decision, reason, demand: 0, buyUnitCost, buildUnitCost, buildSavingsPerHour, children: [] });
      unitCost.set(typeId, cost);
    }
    return cost;
  };
  decide(rootTypeId, false);

  const isBuilt = (t: number) => nodes.get(t)?.decision === "build";

  // ---- 3. aggregate (top-down, topological) ------------------------------
  // Reverse post-order over built nodes = every consumer before its producer.
  const order: number[] = [];
  const seen = new Set<number>();
  const visit = (t: number) => {
    if (seen.has(t)) return;
    seen.add(t);
    const d = info.get(t)!;
    if (isBuilt(t) && d.recipe) for (const m of d.recipe.materials) if (!d.cyclic.has(m.typeId)) visit(m.typeId);
    order.push(t);
  };
  visit(rootTypeId);
  order.reverse();

  const demand = new Map<number, number>();
  const add = (t: number, q: number) => demand.set(t, (demand.get(t) ?? 0) + q);
  const jobs: TreeJob[] = [];
  const purchases = new Map<number, number>();

  for (const t of order) {
    const node = nodes.get(t) ?? {
      // cyclic-only child, never decided normally
      typeId: t, decision: "buy" as const, reason: "cycle", demand: 0, buyUnitCost: null, buildUnitCost: null, buildSavingsPerHour: null, children: [],
    };
    nodes.set(t, node);
    const r = info.get(t)!.recipe;
    if (node.decision === "build" && r) {
      const outputPerRun = r.products.find((p) => p.typeId === t)?.quantity ?? 1;
      const runs = t === rootTypeId ? rootRuns : Math.ceil((demand.get(t) ?? 0) / outputPerRun);
      node.demand = t === rootTypeId ? runs * outputPerRun : demand.get(t) ?? 0;
      if (runs === 0) continue;
      const facility = ctx.facility(r.activity);
      const { me, te } = levels(r);
      const cls = ctx.itemClass?.(t);
      const mult = materialMultiplier(facility, r.activity, cls);
      const mats = materialsForJob(r.materials, runs, me, mult);
      node.children = mats.map((m) => ({ typeId: m.typeId, quantity: m.quantity, baseQuantity: m.baseQuantity }));
      for (const m of mats) add(m.typeId, m.quantity);
      const { eiv, missing } = estimatedItemValue(r.materials, runs, ctx.adjustedPrice);
      if (missing.length) warnings.push(`no adjusted price for ${missing.join(", ")} — job cost of ${t} understated`);
      const output = runs * outputPerRun;
      node.job = {
        typeId: t,
        blueprintTypeId: r.blueprintTypeId,
        activity: r.activity,
        me,
        te,
        runs,
        outputPerRun,
        output,
        surplus: output - node.demand,
        cost: jobInstallCost(eiv, r.activity, ctx.costIndex(r.activity), facility, cls),
        timeSeconds: jobTime(r.time, runs, te, r.activity, facility, ctx.skills, cls, r.skills),
        materialMultiplier: mult,
      };
      jobs.push(node.job);
    } else {
      node.demand = demand.get(t) ?? 0;
      purchases.set(t, (purchases.get(t) ?? 0) + node.demand);
    }
  }
  jobs.reverse(); // inputs first

  const shopping: ShoppingLine[] = [...purchases.entries()]
    .filter(([, q]) => q > 0)
    .map(([typeId, quantity]) => {
      const unitPrice = quotePrice(ctx.quote(typeId), ctx.materialPriceMode);
      if (unitPrice === null) warnings.push(`no market price for ${typeId} — total cost understated`);
      return {
        typeId,
        quantity,
        unitPrice,
        cost: unitPrice === null ? null : quantity * unitPrice * (1 + acqFee),
        freight: quantity * freightPerUnit(typeId),
      };
    })
    .sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0));

  const materialCost = shopping.reduce((s, l) => s + (l.cost ?? 0), 0);
  const freightCost = shopping.reduce((s, l) => s + l.freight, 0);
  const jobCost = jobs.reduce((s, j) => s + j.cost.total, 0);
  const root = nodes.get(rootTypeId)!;
  const surplusCredit = jobs.reduce((s, j) => {
    if (j.typeId === rootTypeId || j.surplus <= 0) return s;
    const n = nodes.get(j.typeId)!;
    return s + j.surplus * (n.buildUnitCost ?? n.buyUnitCost ?? 0);
  }, 0);

  return {
    rootTypeId,
    rootRuns,
    nodes,
    jobs,
    shopping,
    materialCost,
    jobCost,
    surplusCredit,
    freightCost,
    totalCost: materialCost + jobCost + freightCost - surplusCredit,
    totalJobSeconds: jobs.reduce((s, j) => s + j.timeSeconds, 0),
    output: root.job?.output ?? 0,
    warnings: [...new Set(warnings)],
  };
}
