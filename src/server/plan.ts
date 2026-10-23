/**
 * Weekly plan: candidates from the overview, batches sized to Nick's login rhythm, scheduled on
 * the real free slots of the characters (skills − running jobs), within a budget.
 */
import { batchRunsForCadence, marginalValues, planWeek, slotDays, splitSequential, type MarginalValues, type PlanInput, type StockUse, type Plan, type PlanBatch, type PlanJob, type SlotKind, type SlotState } from "@/engine/planner";
import type { Activity } from "@/engine/types";
import { JOB_ACTIVITY_IDS, SLOT_SKILLS } from "@/engine/bonuses";
import { characters, industryJobs } from "@/db/schema";
import { eq } from "drizzle-orm";
import { calculate, type CalcResponse } from "./calculate";
import { CATEGORIES, isCaldariBranchShip, isCapitalRig, RACE_CALDARI, shipInputs, type CategoryKey } from "./catalog";
import { ownedBlueprintIndex, skillLevels } from "./characters";
import { getDb, getSde, getSettings, priceBook, volumesFor } from "./data";
import { recipeLookup } from "@/sde/recipes";
import fs from "node:fs";
import path from "node:path";
import { jobOutputs, stockIndex } from "./assets";
import { planStages, type StageBuyInfo, type StageRecipe, type Stages } from "@/engine/stages";
import { buyOrderAdvice, quotePrice } from "@/engine/pricing";
import { materialQuantity } from "@/engine/materials";
import { computeOverview, overviewRows, type OverviewRow } from "./overview";

export interface PlanRequest {
  budget: number;
  cadenceDays: number;
  horizonDays: number;
  categories: CategoryKey[];
  /** Largest share of the item's weekly market volume to plan for (0.3 = 30%). */
  marketShare: number;
  /** How many top overview items to evaluate in full. */
  candidates?: number;
  /** Skip batches that earn less than this: not worth a separate job to babysit. */
  minBatchProfit: number;
  /** Plan Caldari ships before anything else (then by profit per slot-day). */
  caldariShipsFirst: boolean;
  /** Max share of the budget one item may take (0..1). */
  maxItemShare: number;
  /** Batches made largely from what is in stock go first within their tier (default on). */
  stockFirst?: boolean;
  /** Purchase list: materials for this many weeks of the same plan (stock counted once). */
  buyWeeks?: number;
  /** Longest reaction job, days: longer ones run as parallel jobs. 0 = no cap. */
  maxReactionJobDays?: number;
  /** Longest manufacturing job, days: a longer blueprint runs as sequential jobs. 0 = no cap. */
  maxManufacturingJobDays?: number;
  /** Fill reaction slots left idle with reactions for sale below the minimum batch profit (default on). */
  fillIdleReactions?: boolean;
  /** Items Nick always wants in the plan, with how many batches; planned before everything else. */
  pins?: { typeId: number; batches: number }[];
}

export interface SlotSummary {
  owner: string;
  manufacturing: { total: number; busy: number };
  reaction: { total: number; busy: number };
  science: { total: number; busy: number };
}

export interface PlanResponse extends Plan {
  request: PlanRequest;
  slots: SlotSummary[];
  shopping: { typeId: number; name: string; quantity: number; cost: number | null; volume: number }[];
  /** Invention needed for invented batches (the lab jobs themselves are in `prep`). */
  invention: {
    name: string;
    batches: number;
    attemptsPerBatch: number;
    source: string;
    decryptor: string | null;
    runsPerBpc: number;
    /** Expected attempts for all BPCs of the route together, and the lab time of one. */
    attempts?: number;
    secondsPerAttempt?: number;
  }[];
  /** The plan split into stages (deepest first) with stock taken off, and the purchase list. */
  stages: Stages;
  /** Where the stock came from. */
  stock: {
    locations: number[];
    syncedAt: string | null;
    owners: number;
    types: number;
    /** What running jobs deliver inside the plan: counted as stock (missing in plans saved before). */
    inJobs?: { typeId: number; name: string; quantity: number }[];
  };
  /** All evaluated candidates, best first — the "sheet" for planning by hand or with Claude. */
  sheet: {
    name: string;
    category: string;
    runs: number;
    decryptor: string | null;
    profit: number;
    capital: number;
    slotDays: number;
    profitPerSlotDay: number;
    jobs: number;
    marketDays: number | null;
    risks: string[];
  }[];
  /** What one more slot, character or billion would add (the plan is made again with it). */
  marginal: MarginalValues;
  /** Set when buying some intermediates (the slot earns more on hulls) gave a better plan. */
  slotPass: {
    /** ISK per slot-hour an intermediate had to save to be built. */
    bar: { manufacturing: number; reaction: number };
    /** Extra profit against building everything that is cheaper. */
    gain: number;
    bought: { typeId: number; name: string; activity: Activity; savesPerHour: number }[];
  } | null;
  computedMs: number;
}

const DAY = 86_400_000;
const slotOf = (activityId: number): SlotKind =>
  activityId === JOB_ACTIVITY_IDS.manufacturing ? "manufacturing" : (JOB_ACTIVITY_IDS.reactions as readonly number[]).includes(activityId) ? "reaction" : "science";

export function characterSlots(now: number): { slots: SlotState[]; summary: SlotSummary[] } {
  const db = getDb();
  const slots: SlotState[] = [];
  const summary: SlotSummary[] = [];
  for (const c of db.select().from(characters).all()) {
    const lv = skillLevels(c.characterId);
    const count = (ids: readonly number[]) => 1 + ids.reduce((s, id) => s + (lv.get(id) ?? 0), 0);
    const total = { manufacturing: count(SLOT_SKILLS.manufacturing), reaction: count(SLOT_SKILLS.reaction), science: count(SLOT_SKILLS.science) };
    const active = db
      .select()
      .from(industryJobs)
      .where(eq(industryJobs.installerId, c.characterId))
      .all()
      .filter((j) => j.status === "active");
    const busyEnds: Record<string, number[]> = { manufacturing: [], reaction: [], science: [] };
    for (const j of active) busyEnds[slotOf(j.activityId)].push(Math.max(0, (Date.parse(j.endDate) - now) / DAY));
    for (const kind of ["manufacturing", "reaction", "science"] as SlotKind[]) {
      const ends = busyEnds[kind].sort((a, b) => a - b);
      for (let i = 0; i < total[kind]; i++) slots.push({ kind, owner: c.name, freeAt: ends[i] ?? 0 });
    }
    // Finished but not delivered jobs still show as active in ESI: they free up at the next login.
    const busy = (k: string) => busyEnds[k].filter((d) => d > 0).length;
    summary.push({
      owner: c.name,
      manufacturing: { total: total.manufacturing, busy: busy("manufacturing") },
      reaction: { total: total.reaction, busy: busy("reaction") },
      science: { total: total.science, busy: busy("science") },
    });
  }
  return { slots, summary };
}

/** Chain depth of every built type: root 0, its inputs 1, … (longest path). */
function depths(r: CalcResponse): Map<number, number> {
  const byId = new Map(r.nodes.map((n) => [n.typeId, n]));
  const depth = new Map<number, number>();
  const walk = (id: number, d: number, seen: Set<number>) => {
    if (seen.has(id)) return;
    if ((depth.get(id) ?? -1) >= d) return;
    depth.set(id, d);
    const n = byId.get(id);
    if (!n || n.decision !== "build") return;
    const next = new Set(seen).add(id);
    for (const c of n.children) walk(c.typeId, d + 1, next);
  };
  walk(r.product.typeId, 0, new Set());
  return depth;
}

export function toBatch(r: CalcResponse): PlanBatch {
  const depth = depths(r);
  const { source: sde } = getSde();
  const jobs: PlanJob[] = r.jobs
    .filter((j) => j.activity === "manufacturing" || j.activity === "reaction")
    .map((j) => ({
      typeId: j.typeId,
      name: j.name,
      activity: j.activity,
      runs: j.runs,
      seconds: j.timeSeconds,
      depth: depth.get(j.typeId) ?? 1,
      maxRunsPerJob: sde.getBlueprint(j.blueprintTypeId)?.maxProductionLimit || undefined,
    }));
  // Invention for the next round's BPC: expected attempts on a lab slot, before everything else.
  const inv = r.request.blueprintSource === "invention" ? r.invention.chosen : null;
  if (inv && inv.chance > 0 && inv.secondsPerAttempt > 0) {
    const depth = Math.max(0, ...jobs.map((j) => j.depth)) + 1;
    jobs.push({ typeId: r.product.typeId, name: `${r.product.name} (инвент)`, activity: "invention", runs: 1 / inv.chance, seconds: inv.secondsPerAttempt / inv.chance, depth });
    // Each attempt eats one run of a T1 copy: copied from your own BPO on a lab slot first.
    if (inv.copySecondsPerRun && ownedBlueprintIndex().get(inv.sourceId)?.isBpo) {
      jobs.push({
        typeId: r.product.typeId,
        name: `${inv.sourceName} (копии для ${r.product.name})`,
        activity: "copying",
        runs: 1 / inv.chance,
        seconds: inv.copySecondsPerRun / inv.chance,
        depth: depth + 1,
      });
    }
  }
  return {
    typeId: r.product.typeId,
    name: r.product.name,
    runs: r.request.runs,
    units: r.summary.output,
    profit: r.summary.profit ?? 0,
    capital: r.summary.totalCost,
    jobs,
  };
}

export type Row = OverviewRow & { category: string; categoryKey: CategoryKey };

/** Reactions that feed Caldari ships rank this much higher (Nick's preference, soft). */
const PREFER_CALDARI_REACTIONS = 1.15;

interface Sized {
  route: "owned" | "invention";
  runs: number;
  /** undefined = settings default; null = no decryptor. */
  decryptorId?: number | null;
  /** Relic / T1 blueprint the runs were sized for (another source gives a BPC of another length). */
  inventionSourceId?: number;
  profit: number;
  score: number;
  /** Own BPCs of exactly this length: one batch each. */
  maxBatches?: number;
}

/** A reaction for sale that earns something, but less than a batch must: only fills idle reaction slots. */
export const isFillerRoute = (categoryKey: CategoryKey, profit: number, minBatchProfit: number) => categoryKey === "reactions" && profit > 0 && profit < minBatchProfit;

/** Fillers go after every other tier; at most this many reactions are tried. */
const FILLER_TIER = 99;
const MAX_FILLERS = 30;

/** Own BPC lengths planned separately (longest groups first); shorter leftovers are ignored. */
const MAX_BPC_GROUPS = 3;

/**
 * Batch size per way of getting the blueprint, with the best profit per occupied product slot-day.
 * Own BPO/BPC: its runs. Invention (also when you still have a few BPCs left): every source and
 * decryptor is tried — +runs decryptors turn 1-run BPCs into multi-day jobs (Flycatcher with
 * Augmentation). Over the manufacturing cap a BPC runs as sequential jobs (`splitSequential`).
 */
export function sizeRoutes(r: Row, cad: number, horizon: number, minProfit = 0, bpcRuns: number[] = [], allowLoss = false, capDays?: number): Sized[] {
  // Pinned items are sized even at a loss (Nick decided to build them anyway).
  const ok = (profit: number) => profit > 0 || allowLoss;
  // A fixed-length blueprint (own BPC, invented BPC) over the cap runs as sequential jobs.
  const occupiedBy = (runs: number, secondsPerRun: number, partCost?: (runs: number) => number) =>
    splitSequential({ runs, secondsPerRun, capDays, cadenceDays: cad, partCost });
  const pick = (secondsPerRun: number, profitPerRun: number, maxRuns: number) => {
    // A BPO is sized to fit the cap in one job.
    const runs = batchRunsForCadence({ secondsPerRun, profitPerRun, maxRuns, cadenceDays: cad, horizonDays: capDays ? Math.min(horizon, Math.max(cad, capDays)) : horizon, minProfit });
    const occupied = Math.max(cad, Math.ceil((runs * secondsPerRun) / 86_400 / cad) * cad);
    return { runs, profit: profitPerRun * runs, score: (profitPerRun * runs) / occupied };
  };
  const out: Sized[] = [];
  if (r.blueprintSource === "bpo" || r.blueprintSource === "bpc") {
    const perRun = (r.profit ?? 0) / r.runs;
    // An own BPC is used up whole, one batch per copy of its real length; a BPO is sized for the login rhythm.
    if (ok(perRun) && r.blueprintSource === "bpc" && r.maxRuns > 0) {
      const groups = new Map<number, number>();
      for (const n of bpcRuns.length ? bpcRuns : [r.maxRuns]) groups.set(n, (groups.get(n) ?? 0) + 1);
      for (const [runs, count] of [...groups.entries()].sort((a, b) => b[0] - a[0]).slice(0, MAX_BPC_GROUPS)) {
        // The material cost of splitting is not known here (no tree yet): it is taken off in the batch.
        const occupied = occupiedBy(runs, r.jobSeconds / r.runs).slotDays;
        out.push({ route: "owned", runs, profit: perRun * runs, score: (perRun * runs) / occupied, maxBatches: count });
      }
    } else if (ok(perRun)) out.push({ route: "owned", ...pick(r.jobSeconds / r.runs, perRun, r.maxRuns) });
    if (r.blueprintSource === "bpo") return out;
  }
  const first = calculate({ typeId: r.typeId, runs: r.runs, blueprintSource: "invention", compareDecryptors: true });
  if (first.request.blueprintSource !== "invention") return out;
  // Every source × every decryptor: a relic that is dearer per run may give the BPC length that fits
  // the logins (T3: three relics; T2: one T1 blueprint).
  const others = first.invention.options.filter((o) => o.sourceId !== first.invention.chosen?.sourceId);
  const bySource = [first, ...others.map((o) => calculate({ typeId: r.typeId, runs: r.runs, blueprintSource: "invention", inventionSourceId: o.sourceId, compareDecryptors: true }))];
  let best: Sized | null = null;
  for (const c of bySource) {
    const base = (c.jobs.at(-1)?.timeSeconds ?? r.jobSeconds) / r.runs;
    const te0 = c.request.te;
    for (const d of c.invention.comparison) {
      if (d.profit === null) continue;
      const secondsPerRun = (base * (1 - d.te / 100)) / (1 - te0 / 100);
      // An invented BPC is used up whole: its cost per run assumes every run gets built. Split into
      // sequential jobs over the cap, it pays for materials rounded per job (with this decryptor's ME).
      const perRun = d.profit / r.runs;
      const split = occupiedBy(d.runsPerSuccess, secondsPerRun, partCostFor(c, d.me));
      const profit = perRun * d.runsPerSuccess - split.extraCost;
      const s = { runs: d.runsPerSuccess, profit, score: profit / split.slotDays };
      // Batches above the minimum first; then score; ties → the longer batch (fewer logins).
      const big = (x: { profit: number }) => x.profit >= minProfit;
      if (
        ok(s.profit) &&
        (!best ||
          (big(s) && !big(best)) ||
          (big(s) === big(best) && (s.score > best.score * 1.0001 || (s.score >= best.score * 0.9999 && s.runs > best.runs))))
      ) {
        best = { route: "invention", ...s, decryptorId: d.decryptorId, inventionSourceId: c.invention.chosen?.sourceId };
      }
    }
  }
  if (best) out.push(best);
  return out;
}


export function buildPlan(req: PlanRequest): PlanResponse {
  const t0 = Date.now();
  const now = Date.now();
  const cad = Math.max(1, req.cadenceDays);
  const horizon = Math.max(cad, req.horizonDays);

  const mfgCap = req.maxManufacturingJobDays || undefined;
  const pins = new Map((req.pins ?? []).filter((p) => p.batches > 0).map((p) => [p.typeId, Math.round(p.batches)]));
  const { source: sde } = getSde();

  // Candidates: best overview rows across the chosen categories (one row per item).
  const rows = new Map<number, Row>();
  const pinErrors = new Map<number, { name: string; reason: string }>();
  const skipNoMarket = getSettings().planSkipNoMarket;
  const noMarket = new Map<number, string>();
  const addRow = (r: OverviewRow, category: string, categoryKey: CategoryKey) => {
    const pinned = pins.has(r.typeId);
    if (r.error || r.profit === null || !r.jobSeconds || !r.runs) {
      if (pinned) pinErrors.set(r.typeId, { name: r.name, reason: `закреплено, но не считается: ${r.error ?? "нет цены"}` });
      return;
    }
    // Invented rows stay even if unprofitable at the default decryptor: another one may fix that.
    if (r.profit <= 0 && r.blueprintSource !== "invention" && !pinned) return;
    // No market (history): it would only sell into buy orders. Pinned items are Nick's call.
    if (skipNoMarket && !pinned && r.priceFlags.some((f) => f.kind === "no_market")) {
      if (!noMarket.has(r.typeId)) noMarket.set(r.typeId, r.name);
      return;
    }
    // Capital rigs are never planned (expensive blueprints, too much capital per batch) unless pinned.
    if (!pinned && isCapitalRig(sde, sde.getType(r.typeId))) return;
    if (!rows.has(r.typeId)) rows.set(r.typeId, { ...r, category, categoryKey });
  };
  for (const key of req.categories) {
    const label = CATEGORIES.find((c) => c.key === key)?.label ?? key;
    for (const r of computeOverview(key).rows) addRow(r, label, key);
  }
  // Pinned items outside the chosen categories (or hidden by the blacklist) are evaluated on their own.
  const pinTypes = [...pins.keys()].filter((id) => !rows.has(id) && !pinErrors.has(id)).flatMap((id) => sde.getType(id) ?? []);
  for (const r of overviewRows(pinTypes).rows) addRow(r, "Закреплено", "mine");
  // Size each row for the login rhythm. Invented items also pick the decryptor that gives the best
  // profit per occupied slot-day: +runs decryptors turn 1-run BPCs into multi-day jobs (Flycatcher).
  const caldariInputs = shipInputs(sde, new Set([RACE_CALDARI]));
  const recipe = recipeLookup(sde);
  const ownedIdx = ownedBlueprintIndex();
  const sized = [...rows.values()].flatMap((r) => {
    try {
      const t = sde.getType(r.typeId);
      const weight = r.categoryKey === "reactions" && caldariInputs.has(r.typeId) ? PREFER_CALDARI_REACTIONS : 1;
      // 0 = Caldari hulls; 1 = what dilutes them (rigs, reactions, other Caldari items); 2 = the rest.
      const caldariShip = !!t && isCaldariBranchShip(t);
      const filler = r.categoryKey.startsWith("rigs") || r.categoryKey === "reactions" || t?.raceId === RACE_CALDARI;
      const tier = !req.caldariShipsFirst ? 0 : caldariShip ? 0 : filler ? 1 : 2;
      const bp = recipe(r.typeId)?.blueprintTypeId;
      return sizeRoutes(r, cad, horizon, req.minBatchProfit, bp ? ownedIdx.get(bp)?.bpcRuns : undefined, pins.has(r.typeId), mfgCap).map((s) => ({ r, ...s, weight, tier }));
    } catch {
      return [];
    }
  });
  // A pinned item is pinned on every route (own BPCs, then invention): the planner takes the best
  // one first and adds the rest from the next when it runs out.
  const pinnedRoute = new Set(sized.filter((x) => pins.has(x.r.typeId)).map((x) => x.r.typeId));
  const isPinned = (x: (typeof sized)[number]) => pinnedRoute.has(x.r.typeId);
  // Reactions for sale below the minimum batch profit: not worth a job of their own, but better
  // than an idle reaction slot. Planned last, on whatever slots and budget are left.
  const isFiller = (x: (typeof sized)[number]) => req.fillIdleReactions !== false && !isPinned(x) && isFillerRoute(x.r.categoryKey, x.profit, req.minBatchProfit);
  const top = [
    ...sized
      .filter((x) => x.profit >= req.minBatchProfit || isPinned(x))
      .sort((a, b) => Number(isPinned(b)) - Number(isPinned(a)) || a.tier - b.tier || b.score * b.weight - a.score * a.weight)
      .slice(0, (req.candidates ?? 150) + sized.filter(isPinned).length),
    ...sized
      .filter(isFiller)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_FILLERS)
      .map((x) => ({ ...x, tier: FILLER_TIER, filler: true })),
  ];

  interface Evaluated {
    calcs: Map<string, CalcResponse>;
    candidates: PlanBatch[];
    unitCap: Map<number, number>;
    unpriced: string[];
    noBlueprint: string[];
  }
  /**
   * Full calculation of the top rows. With `slotBar` (ISK per slot-hour), intermediates that save
   * less than that are bought; calculations from `prev` where that changes nothing are reused.
   */
  const evaluate = (slotBar?: SlotBar, prev?: Evaluated): Evaluated => {
    const out: Evaluated = { calcs: new Map(), candidates: [], unitCap: new Map(), unpriced: [], noBlueprint: [] };
    for (const x of top) {
      const { r, route, runs, decryptorId, inventionSourceId, weight, tier, maxBatches } = x;
      const filler = "filler" in x && x.filler === true;
      const pinned = isPinned(x) ? pins.get(r.typeId) : undefined;
      const key = `${r.typeId}:${route}${maxBatches !== undefined ? `:${runs}` : ""}`;
      try {
        const old = prev?.calcs.get(key);
        const c =
          old && !(slotBar && buildsBelowBar(old, slotBar))
            ? old
            : calculate({
                typeId: r.typeId,
                runs,
                blueprintSource: route,
                ...(route === "invention" && decryptorId !== undefined ? { decryptorId } : {}),
                ...(route === "invention" && inventionSourceId !== undefined ? { inventionSourceId } : {}),
                ...(slotBar ? { slotIskPerHour: slotBar } : {}),
              });
        // A missing price understates the cost: such a "profit" is not real.
        if (c.warnings.some((w) => w.includes("нет рыночной цены"))) {
          out.unpriced.push(r.name);
          continue;
        }
        const owned = c.request.blueprintSource === "owned" ? c.ownedBlueprint : null;
        // Only what you can actually start: your own blueprint, or one you can invent.
        if (!owned && c.request.blueprintSource !== "invention") {
          out.noBlueprint.push(r.name);
          continue;
        }
        out.calcs.set(key, c);
        // Own BPCs: one batch per copy. BPO or invention: limited by market and slots only.
        const batch = splitProduct(toBatch(c), c, cad, mfgCap);
        if (batch.profit < req.minBatchProfit && !pinned && !(filler && batch.profit > 0)) continue;
        out.candidates.push({ ...batch, key, weight, tier, pinned, ...(filler ? { filler } : {}), maxBatches: maxBatches ?? (owned && !owned.isBpo ? owned.copies : undefined) });
        // Market cap: a share of what sells over the horizon. No history = one batch at most.
        out.unitCap.set(r.typeId, r.avgDailyVolume30d ? r.avgDailyVolume30d * horizon * req.marketShare : c.summary.output);
      } catch {
        /* not calculable at this size — skip */
      }
    }
    return out;
  };

  const { slots, summary } = characterSlots(now);
  // Stock = hangars + what running factory/reaction jobs deliver inside the plan.
  const stockInfo = stockIndex();
  const inJobs = jobOutputs(horizon, now);
  const stock = new Map(stockInfo.stock);
  for (const [id, q] of inJobs) stock.set(id, (stock.get(id) ?? 0) + q);
  const inputFor = (e: Evaluated): PlanInput => ({
    candidates: e.candidates,
    slots,
    budget: req.budget,
    cadenceDays: cad,
    horizonDays: horizon,
    maxBatchesPerItem: 10,
    maxItemShare: req.maxItemShare,
    maxJobDays: req.maxReactionJobDays ? { reaction: req.maxReactionJobDays } : undefined,
    unitCap: (id) => e.unitCap.get(id) ?? 0,
    // Stock is used up batch by batch and is not paid from the budget.
    stock,
    stockUse: stockUseFor(e.calcs, horizon, req.maxReactionJobDays),
    stockFirst: req.stockFirst !== false,
  });
  let ev = evaluate();
  let input = inputFor(ev);
  let plan = planWeek(input);
  let marginal = marginalValues(input, plan);
  // Second pass: a slot-hour on hulls earns more than some intermediates save per hour → buy those,
  // the freed slot time goes to more hulls. Kept only if the plan really earns more.
  const bar: SlotBar = { manufacturing: marginal.slotDay.manufacturing / 24, reaction: marginal.slotDay.reaction / 24 };
  let slotPass: PlanResponse["slotPass"] = null;
  if (Math.max(bar.manufacturing, bar.reaction) > getSettings().minBuildIskPerHour) {
    const ev2 = evaluate(bar, ev);
    const input2 = inputFor(ev2);
    const plan2 = planWeek(input2);
    if (plan2.profit > plan.profit) {
      slotPass = { bar, gain: plan2.profit - plan.profit, bought: boughtForSlots(plan2, ev2.calcs) };
      [ev, input, plan] = [ev2, input2, plan2];
      marginal = marginalValues(input, plan);
    }
  }
  const { calcs, candidates, unpriced, noBlueprint } = ev;

  // One shopping list for everything in the plan.
  const shop = new Map<number, PlanResponse["shopping"][number]>();
  const inv = new Map<string, PlanResponse["invention"][number]>();
  for (const b of plan.batches) {
    const c = calcs.get(b.key ?? String(b.typeId))!;
    for (const l of c.shopping) {
      const cur = shop.get(l.typeId) ?? { typeId: l.typeId, name: l.name, quantity: 0, cost: 0, volume: 0 };
      cur.quantity += l.quantity;
      cur.cost = cur.cost === null || l.cost === null ? null : cur.cost + l.cost;
      cur.volume += l.volume;
      shop.set(l.typeId, cur);
    }
    const ch = c.request.blueprintSource === "invention" ? c.invention.chosen : null;
    if (ch) {
      const cur = inv.get(b.key ?? String(b.typeId)) ?? {
        name: b.name,
        batches: 0,
        attemptsPerBatch: Math.ceil(1 / Math.max(ch.chance, 0.01)),
        source: ch.sourceName,
        decryptor: c.invention.decryptor?.name ?? null,
        runsPerBpc: ch.runsPerSuccess,
        secondsPerAttempt: ch.secondsPerAttempt,
      };
      cur.batches++;
      cur.attempts = Math.ceil(cur.batches / Math.max(ch.chance, 0.01) - 1e-9);
      inv.set(b.key ?? String(b.typeId), cur);
    }
  }

  const stages = stagesFor(plan, calcs, horizon, { info: stockInfo, stock, inJobs }, req.maxReactionJobDays, req.buyWeeks);

  const sheet = candidates
    .map((b) => {
      const r = rows.get(b.typeId)!;
      const days = Math.round(slotDays(b, cad) * 10) / 10;
      const c = calcs.get(b.key ?? String(b.typeId));
      return {
        name: b.name + (c?.request.blueprintSource === "invention" ? " (инвент)" : b.key?.split(":").length === 3 ? ` (свой BPC на ${b.runs} ран.)` : " (свой чертёж)"),
        category: r.category,
        runs: b.runs,
        decryptor: c?.request.blueprintSource === "invention" ? c.invention.decryptor?.name ?? null : null,
        profit: b.profit,
        capital: b.capital,
        slotDays: days,
        profitPerSlotDay: b.profit / Math.max(cad, days),
        jobs: b.jobs.length,
        marketDays: r.avgDailyVolume30d ? b.units / r.avgDailyVolume30d : null,
        risks: r.marketRisks,
      };
    })
    .sort((a, b) => b.profitPerSlotDay - a.profitPerSlotDay);

  for (const name of unpriced) plan.skipped.push({ name, reason: "нет цены на часть материалов" });
  for (const name of noBlueprint) plan.skipped.push({ name, reason: "нет чертежа и нельзя заинвентить" });
  plan.skipped.push(...pinErrors.values());
  for (const [id, name] of noMarket) if (!rows.has(id)) plan.skipped.push({ name, reason: "нет рынка: почти нет сделок за 30 дней" });
  for (const id of pins.keys()) {
    if (!sde.getType(id)) plan.skipped.push({ name: `#${id}`, reason: "закреплено, но нет в SDE" });
    else if (rows.has(id) && !pinnedRoute.has(id)) plan.skipped.push({ name: rows.get(id)!.name, reason: "закреплено, но нет своего чертежа в плюс и нельзя заинвентить" });
  }

  return {
    ...plan,
    request: { ...req, cadenceDays: cad, horizonDays: horizon },
    slots: summary,
    shopping: [...shop.values()].sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0)),
    invention: [...inv.values()],
    stages: stages.stages,
    stock: stages.stock,
    sheet,
    marginal,
    slotPass,
    computedMs: Date.now() - t0,
  };
}

/**
 * Cost of what one product job of `runs` runs consumes, at this ME (materials rounded per job as
 * in game), valued like the tree values them (build or buy). Undefined when the product is not built.
 */
export function partCostFor(c: CalcResponse, me: number): ((runs: number) => number) | undefined {
  const root = c.nodes.find((n) => n.typeId === c.product.typeId);
  const job = root?.job;
  if (!root || !job || job.runs <= 0) return undefined;
  const unit = new Map(c.nodes.map((n) => [n.typeId, (n.decision === "build" ? n.buildUnitCost : n.buyUnitCost) ?? 0]));
  return (runs) =>
    root.children.reduce((s, ch) => {
      const q = ch.baseQuantity === undefined ? Math.ceil((ch.quantity / job.runs) * runs - 1e-9) : materialQuantity(ch.baseQuantity, runs, me, job.materialMultiplier);
      return s + q * (unit.get(ch.typeId) ?? 0);
    }, 0);
}

/** A manufactured product over the cap: sequential jobs of the same blueprint; extra materials come off the profit. */
function splitProduct(b: PlanBatch, c: CalcResponse, cad: number, capDays?: number): PlanBatch {
  const product = b.jobs.find((j) => j.depth === 0);
  if (!capDays || !product || product.activity !== "manufacturing" || product.runs <= 0) return b;
  const split = splitSequential({ runs: product.runs, secondsPerRun: product.seconds / product.runs, capDays, cadenceDays: cad, partCost: partCostFor(c, c.request.me) });
  if (split.parts.length < 2) return b;
  return {
    ...b,
    profit: b.profit - split.extraCost,
    capital: b.capital + split.extraCost,
    jobs: b.jobs.map((j) => (j === product ? { ...j, parts: split.parts } : j)),
  };
}

/** ISK an hour of a factory / reaction slot earns on hulls in this plan. */
type SlotBar = { manufacturing: number; reaction: number };

/** Built intermediates (not the product, not a manual or no-market decision) that save less per hour than a slot earns. */
const belowBar = (c: CalcResponse, bar: SlotBar) =>
  c.nodes.filter(
    (n) =>
      n.typeId !== c.product.typeId &&
      n.decision === "build" &&
      n.reason === "cheaper" &&
      (n.activity === "manufacturing" || n.activity === "reaction") &&
      n.buildSavingsPerHour !== null &&
      n.buildSavingsPerHour < bar[n.activity],
  );
const buildsBelowBar = (c: CalcResponse, bar: SlotBar) => belowBar(c, bar).length > 0;

/** What the plan buys because the slot is worth more, one line per type. */
function boughtForSlots(plan: Plan, calcs: Map<string, CalcResponse>): NonNullable<PlanResponse["slotPass"]>["bought"] {
  const out = new Map<number, NonNullable<PlanResponse["slotPass"]>["bought"][number]>();
  for (const b of plan.batches) {
    for (const n of calcs.get(b.key ?? String(b.typeId))?.nodes ?? []) {
      if (n.reason !== "slot value" || out.has(n.typeId) || n.activity === null) continue;
      out.set(n.typeId, { typeId: n.typeId, name: n.name, activity: n.activity, savesPerHour: n.buildSavingsPerHour ?? 0 });
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Stages of the plan: all batches merged, what is in the stock hangars taken off (built
 * components and bought materials), plus datacores and decryptors for invention.
 */
function stagesFor(
  plan: Plan,
  calcs: Map<string, CalcResponse>,
  horizonDays: number,
  st: { info: ReturnType<typeof stockIndex>; stock: Map<number, number>; inJobs: Map<number, number> },
  maxReactionDays?: number,
  buyWeeks = 1,
): { stages: Stages; stock: PlanResponse["stock"] } {
  const { source: sde } = getSde();
  const s = getSettings();
  const recipes = new Map<number, StageRecipe>();
  const buy = new Map<number, StageBuyInfo>();
  const extra = new Map<number, number>();
  const note = new Map<number, string>();
  // Invented BPCs per route: attempts are an expectation over all of them (like EVE Guru), not per BPC.
  const invented = new Map<string, { c: CalcResponse; bpcs: number }>();
  for (const b of plan.batches) {
    const key = b.key ?? String(b.typeId);
    const c = calcs.get(key);
    if (!c) continue;
    const m = stageModel(c, horizonDays, maxReactionDays);
    for (const [id, r] of m.recipes) if (!recipes.has(id)) recipes.set(id, r);
    for (const [id, b] of m.buy) if (!buy.has(id)) buy.set(id, b);
    if (c.request.blueprintSource === "invention" && c.invention.chosen) {
      const cur = invented.get(key) ?? { c, bpcs: 0 };
      cur.bpcs++;
      invented.set(key, cur);
    }
  }

  const owned = ownedBlueprintIndex();
  const copies: NonNullable<Stages["blueprints"]> = [];
  for (const { c, bpcs } of invented.values()) {
    const ch = c.invention.chosen!;
    const attempts = Math.ceil(bpcs / Math.max(ch.chance, 0.01) - 1e-9);
    const add = (id: number, q: number, why: string) => {
      extra.set(id, (extra.get(id) ?? 0) + q);
      note.set(id, why);
    };
    for (const m of sde.getBlueprint(ch.sourceId)?.activities.invention?.materials ?? []) add(m.typeId, m.quantity * attempts, "инвент");
    if (c.invention.decryptor) add(c.invention.decryptor.typeId, attempts, "инвент");
    // The source is used up by every attempt: a relic is bought, a T1 blueprint needs one copy per attempt.
    const src = sde.getType(ch.sourceId);
    if (src?.categoryId === CATEGORY_BLUEPRINT) {
      const o = owned.get(ch.sourceId);
      copies.push({ typeId: ch.sourceId, name: src.name, copies: attempts, forItem: c.product.name, how: o?.isBpo ? "copy" : "buy" });
    } else add(ch.sourceId, attempts, "реликт");
  }

  const missing = [...extra.keys()].filter((id) => !buy.has(id));
  const prices = priceBook(missing, s.priceLocationId);
  for (const id of missing) {
    const t = sde.getType(id);
    buy.set(id, { typeId: id, name: t?.name ?? `#${id}`, unitPrice: quotePrice(prices.quote(id), s.materialPriceMode), volume: t ? t.packagedVolume ?? t.volume : 0 });
  }
  const stages = planStages({
    products: plan.jobs.filter((j) => j.depth === 0).map((j) => ({ typeId: j.typeId, runs: j.runs })),
    recipes,
    buy,
    stock: st.stock,
    extraBuy: [...extra.entries()].map(([typeId, quantity]) => ({ typeId, quantity, note: note.get(typeId) ?? "инвент" })),
    buffer: s.buyBuffer,
    weeks: buyWeeks,
    freightPerM3: s.freightInPerM3,
  });
  stages.blueprints = copies.sort((a, b) => a.how.localeCompare(b.how) || b.copies - a.copies);
  // Materials priced at sell orders: where a buy order saves enough and fills within days, say so.
  if (s.materialPriceMode === "sell") {
    const ids = stages.buy.filter((l) => l.toBuy > 0).map((l) => l.typeId);
    const book = priceBook(ids, s.priceLocationId);
    const volume = volumesFor(ids, s.priceRegionId);
    stages.orderSaving = 0;
    for (const l of stages.buy) {
      if (l.toBuy <= 0) continue;
      const advice = buyOrderAdvice(book.quote(l.typeId), l.toBuy, { salesTax: s.salesTax, brokerFee: s.brokerFee }, volume.get(l.typeId)?.avgDailyVolume30d);
      if (!advice) continue;
      l.order = advice;
      stages.orderSaving += advice.saving;
    }
  }
  const inJobs = [...st.inJobs].map(([typeId, quantity]) => ({ typeId, name: sde.getType(typeId)?.name ?? `#${typeId}`, quantity })).sort((a, b) => a.name.localeCompare(b.name));
  return { stages, stock: { locations: st.info.locations, syncedAt: st.info.syncedAt, owners: st.info.owners, types: st.stock.size, inJobs } };
}

/** Recipes and bought items of one calculation, in the shape planStages reads. */
function stageModel(c: CalcResponse, horizonDays: number, maxReactionDays?: number): { recipes: Map<number, StageRecipe>; buy: Map<number, StageBuyInfo> } {
  const { source: sde } = getSde();
  const recipes = new Map<number, StageRecipe>();
  const buy = new Map<number, StageBuyInfo>();
  for (const n of c.nodes) {
    if (n.decision !== "build" || !n.job || n.job.runs <= 0 || recipes.has(n.typeId)) continue;
    const isProduct = n.typeId === c.product.typeId;
    recipes.set(n.typeId, {
      typeId: n.typeId,
      name: n.name,
      activity: n.job.activity,
      outputPerRun: n.job.outputPerRun,
      secondsPerRun: n.job.timeSeconds / n.job.runs,
      inputs: n.children.map((ch) => ({ typeId: ch.typeId, perRun: ch.quantity / n.job!.runs, base: ch.baseQuantity })),
      me: n.job.me,
      materialMultiplier: n.job.materialMultiplier,
      // Components and reactions must be ready inside the plan: split what is longer than the horizon.
      // Reactions (also sold ones) have their own cap, e.g. 2 days.
      maxJobSeconds:
        n.job.activity === "reaction" && maxReactionDays
          ? Math.min(horizonDays, maxReactionDays) * 86_400
          : isProduct
            ? undefined
            : horizonDays * 86_400,
      maxRunsPerJob: isProduct ? undefined : sde.getBlueprint(n.job.blueprintTypeId)?.maxProductionLimit || undefined,
    });
  }
  const forSlot = new Set(c.nodes.filter((n) => n.reason === "slot value").map((n) => n.typeId));
  for (const l of c.shopping) {
    if (buy.has(l.typeId)) continue;
    buy.set(l.typeId, {
      typeId: l.typeId,
      name: l.name,
      unitPrice: l.cost === null || !l.quantity ? null : l.cost / l.quantity,
      volume: l.quantity ? l.volume / l.quantity : 0,
      flags: l.priceFlags?.map((f) => f.label),
      ...(forSlot.has(l.typeId) ? { note: SLOT_NOTE } : {}),
    });
  }
  return { recipes, buy };
}

/**
 * How one batch uses the stock left: the same top-down pass as the stages (a component on hand
 * also saves its materials), valued at what building (intermediates) or buying (materials) would cost.
 */
function stockUseFor(calcs: Map<string, CalcResponse>, horizonDays: number, maxReactionDays?: number): StockUse {
  const models = new Map<string, ReturnType<typeof stageModel> & { unit: Map<number, number> }>();
  return (b, left) => {
    const key = b.key ?? String(b.typeId);
    const c = calcs.get(key);
    if (!c) return { take: new Map(), value: 0 };
    let m = models.get(key);
    if (!m) {
      const unit = new Map(c.nodes.filter((n) => n.decision === "build" && n.buildUnitCost !== null).map((n) => [n.typeId, n.buildUnitCost!]));
      models.set(key, (m = { ...stageModel(c, horizonDays, maxReactionDays), unit }));
    }
    const st = planStages({ products: [{ typeId: b.typeId, runs: b.runs }], recipes: m.recipes, buy: m.buy, stock: new Map(left) });
    const take = new Map<number, number>();
    let value = 0;
    for (const line of st.stages.flatMap((x) => x.lines)) {
      if (line.isProduct || line.fromStock <= 0) continue;
      take.set(line.typeId, (take.get(line.typeId) ?? 0) + line.fromStock);
      value += line.fromStock * (m.unit.get(line.typeId) ?? 0);
    }
    for (const l of st.buy) {
      if (l.fromStock <= 0) continue;
      take.set(l.typeId, (take.get(l.typeId) ?? 0) + l.fromStock);
      value += l.fromStock * (l.unitPrice ?? 0);
    }
    return { take, value };
  };
}

/** Why a buildable intermediate is in the purchase list. */
export const SLOT_NOTE = "покупаем: слот выгоднее под корпуса";

/** SDE category of blueprints (and nothing else): a T1 invention source, not a relic. */
const CATEGORY_BLUEPRINT = 9;

const sheetName = (id: number) => getSde().source.getType(id)?.name ?? `#${id}`;

/** Plain-text sheet for pasting into a chat with Claude. */
export function sheetText(p: PlanResponse): string {
  const r = p.request;
  const lines = [
    `Бюджет ${r.budget.toLocaleString("ru-RU")} ISK, заход раз в ${r.cadenceDays} дн., горизонт ${r.horizonDays} дн., рынок до ${Math.round(r.marketShare * 100)}% недельного объёма, партии от ${r.minBatchProfit.toLocaleString("ru-RU")} ISK прибыли.`,
    `Слоты: ${p.slots.map((s) => `${s.owner} — производство ${s.manufacturing.total} (занято ${s.manufacturing.busy}), реакции ${s.reaction.total} (занято ${s.reaction.busy}), лаборатории ${s.science.total} (занято ${s.science.busy})`).join("; ")}.`,
    ...(r.pins?.length ? [`Закреплено: ${r.pins.map((x) => `${sheetName(x.typeId)} × ${x.batches}`).join(", ")}.`] : []),
    ...(p.warnings.length ? ["", "Предупреждения плана:", ...p.warnings.map((w) => `- ${w}`)] : []),
    ...(p.marginal
      ? [
          "",
          `Что даст ещё (прибыль за план): +1 производственный слот ${Math.round(p.marginal.slot.manufacturing)}, +1 реакционный ${Math.round(p.marginal.slot.reaction)}, +1 лабораторный ${Math.round(p.marginal.slot.science)}` +
            (p.marginal.character ? `, +персонаж как ${p.marginal.character.like} ${Math.round(p.marginal.character.gain)}` : "") +
            `, +${p.marginal.budget.step.toLocaleString("ru-RU")} ISK бюджета ${Math.round(p.marginal.budget.gain)}.`,
        ]
      : []),
    ...(p.slotPass?.bought.length ? [`Покупаем, хотя дешевле построить (слот дороже): ${p.slotPass.bought.map((b) => b.name).join(", ")}; прибыль плана +${Math.round(p.slotPass.gain)}.`] : []),
    "",
    "Предмет | категория | раны | декриптор | прибыль | капитал | слото-дней | прибыль/слото-день | джоб | дней рынка | риски",
    ...p.sheet.map((s) =>
      [s.name, s.category, s.runs, s.decryptor ?? "—", Math.round(s.profit), Math.round(s.capital), s.slotDays, Math.round(s.profitPerSlotDay), s.jobs, s.marketDays?.toFixed(1) ?? "—", s.risks.join("; ") || "—"].join(" | "),
    ),
  ];
  return lines.join("\n");
}


// ---- last plan --------------------------------------------------------------

const LAST_PLAN = () => path.resolve("data/last-plan.json");

/** Keeps the last plan on disk (data/ is local and never committed). Tests use an in-memory DB and skip it. */
export function rememberPlan(p: PlanResponse & { text: string; computedAt: string }): void {
  if (process.env.PG_APP_DB === ":memory:") return;
  try {
    fs.mkdirSync(path.dirname(LAST_PLAN()), { recursive: true });
    fs.writeFileSync(LAST_PLAN(), JSON.stringify(p));
  } catch {
    /* not critical */
  }
}

export function lastPlan(): (PlanResponse & { text: string; computedAt: string }) | null {
  try {
    return JSON.parse(fs.readFileSync(LAST_PLAN(), "utf8"));
  } catch {
    return null;
  }
}
